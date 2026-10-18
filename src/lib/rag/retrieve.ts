import { Prisma, type RagOrigin, type RagSourceType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolveEffectiveInternal } from "@/lib/config/resolver";
import { embeddingProviderFor } from "@/lib/ai/embeddings";
import { contentWords } from "@/lib/ai/record/mock";
import { activeSpace } from "./embed";
import { AI_MODES, MODES, type AiMode } from "./modes";
import { candidateSearch, scopeSql } from "./search";
import type { AiAccess } from "./access";
import type { RetrievalScope } from "./scope";
import { isoDay } from "./render";
import { sensitiveCategoryOf } from "./sensitivity";

/**
 * Week 4b — retrieval (docs/RAG_DESIGN.md §7). Filters first, in SQL (the
 * access scope from access.ts), then:
 *   1–3  the 40 nearest by exact cosine and the 40 best keyword matches,
 *        fused by reciprocal rank (k = 60);
 *   4    the top 30 reranked (the space's reranker, 0..1), keeping 8 (12 for
 *        the brief, the handoff and the timeline, which also always get the
 *        latest vitals day, the allergy and problem lists, and the live
 *        medicines);
 *   5    ties by recency; "latest", "last" or "current" favour the newest;
 *   6    a verified chunk ranks above a patient-provided one on the same
 *        footing;
 *   7.3  "no record found" when a question's best score is under the mode's
 *        threshold and no keyword match covered the question — the model is
 *        then not asked;
 *   7.4  live facts: active medicines (and, for a nurse, doses due or missed)
 *        and the active allergy list, read now, cited by id.
 */
export interface RetrievedChunk {
  chunkId: string; documentId: string; context: string; heading: string | null; text: string;
  origin: RagOrigin; sourceType: RagSourceType; sourceId: string; recordedAt: Date; handwritten: boolean;
  translatedText: string | null; translationLanguage: string | null;
  score: number;
}

export interface LiveFact {
  /** "live:<kind>:<id>" — cited like a chunk. */
  chunkId: string; context: string; text: string; origin: RagOrigin; sourceType: "MEDICATION_ORDER" | "MEDICATION_DOSE" | "ALLERGY"; sourceId: string; recordedAt: Date;
}

export interface Retrieval {
  chunks: RetrievedChunk[];
  live: LiveFact[];
  topScore: number | null;
  threshold: number;
  noRecord: boolean;
  space: { model: string; version: number };
  candidateIds: string[];
}

const RRF_K = 60;
const LATEST = /\b(latest|last|current|recent|newest|today)\b/i;
const DEFAULT_QUERY: Record<AiMode, string> = {
  VISIT_BRIEF: "history diagnoses medicines allergies results investigations plan",
  CHART_QA: "",
  NURSE_HANDOFF: "vitals doses due missed pending results lines devices risks allergies",
  EXPLAIN_REPORT: "report result value reference range findings impression",
  HEALTH_TIMELINE: "visits diagnoses results procedures medicines discharge",
  PREVISIT_QUESTIONS: "diagnoses results medicines follow up",
};

/** Reciprocal-rank fusion (k = 60) of the vector and keyword ranks, best first (§7.2 step 3). */
export function fuse<T extends { chunkId: string; vectorRank: number | null; keywordRank: number | null }>(candidates: T[]): (T & { rrf: number })[] {
  return candidates.map((c) => ({ ...c, rrf: (c.vectorRank ? 1 / (RRF_K + c.vectorRank) : 0) + (c.keywordRank ? 1 / (RRF_K + c.keywordRank) : 0) }))
    .sort((a, b) => b.rrf - a.rrf || a.chunkId.localeCompare(b.chunkId));
}

/** The mode's "no record" threshold (0..1), from config; a patient mode's is never below any staff mode's (§7.3). */
export async function modeThreshold(mode: AiMode, organizationId: string | null, facilityId: string | null): Promise<number> {
  const read = async (m: AiMode) => {
    if (!organizationId) return MODES[m].defaultThreshold / 1000;
    const eff = await resolveEffectiveInternal({ key: MODES[m].threshold, organizationId, facilityId: facilityId ?? undefined, fallbackRaw: String(MODES[m].defaultThreshold) });
    return (typeof eff.value === "number" ? eff.value : MODES[m].defaultThreshold) / 1000;
  };
  const own = await read(mode);
  if (MODES[mode].audience !== "PATIENT") return own;
  const staff = await Promise.all(AI_MODES.filter((m) => MODES[m].audience === "STAFF").map(read));
  return Math.max(own, ...staff);
}

type ChunkRow = Omit<RetrievedChunk, "score">;
const CHUNK_SELECT = { id: true, documentId: true, context: true, heading: true, text: true, origin: true, sourceType: true, sourceId: true, recordedAt: true, handwritten: true, translatedText: true, translationLanguage: true } as const;
const toRow = (c: { id: string } & Omit<ChunkRow, "chunkId">): ChunkRow => ({ chunkId: c.id, documentId: c.documentId, context: c.context, heading: c.heading, text: c.text, origin: c.origin, sourceType: c.sourceType, sourceId: c.sourceId, recordedAt: c.recordedAt, handwritten: c.handwritten, translatedText: c.translatedText, translationLanguage: c.translationLanguage });

/** Chunks in the scope of these source types (the context the brief, handoff and timeline always get). */
async function contextChunks(scope: RetrievalScope, types: RagSourceType[], take: number): Promise<ChunkRow[]> {
  const ids = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT c."id" FROM "RagChunk" c WHERE ${scopeSql(scope)} AND c."sourceType" = ANY(${types}::"RagSourceType"[]) ORDER BY c."recordedAt" DESC, c."id" LIMIT ${take}`);
  if (!ids.length) return [];
  return (await prisma.ragChunk.findMany({ where: { id: { in: ids.map((r) => r.id) } }, select: CHUNK_SELECT })).map(toRow);
}

async function liveFacts(access: AiAccess): Promise<LiveFact[]> {
  const out: LiveFact[] = [];
  const { patientIds, facilityIds } = access.live;
  if (!patientIds.length) return out;
  // Sensitive medicines follow the scope: a path with no sensitive opt-in never sees one.
  const sensitiveAllowed = new Set(access.scope.segments.flatMap((s) => s.sensitive));
  const ok = (name: string) => { const s = sensitiveCategoryOf({ texts: [name] }); return !s || sensitiveAllowed.has(s); };
  if (access.live.medications) {
    const orders = await prisma.medicationOrder.findMany({
      where: { patientId: { in: patientIds }, encounter: { facilityId: { in: facilityIds } }, status: { in: ["ORDERED", "PHARMACY_REVIEW", "VERIFIED", "DISPENSED", "ACTIVE"] } },
      orderBy: { orderedAt: "desc" }, take: 30, select: { id: true, drugName: true, genericName: true, dose: true, route: true, frequency: true, orderedAt: true, status: true },
    });
    for (const o of orders) {
      if (!ok(`${o.drugName} ${o.genericName ?? ""}`)) continue;
      out.push({ chunkId: `live:med:${o.id}`, context: `[Active medicine · ${o.drugName} · ${isoDay(o.orderedAt)} · verified]`, text: `Active medicine: ${o.drugName} ${o.dose} ${o.route.toLowerCase()} ${o.frequency} (ordered ${isoDay(o.orderedAt)}, ${o.status.toLowerCase().replace(/_/g, " ")}).`, origin: "VERIFIED", sourceType: "MEDICATION_ORDER", sourceId: o.id, recordedAt: o.orderedAt });
    }
    if (access.live.nurseView) {
      const since = new Date(Date.now() - 12 * 3_600_000), until = new Date(Date.now() + 12 * 3_600_000);
      const doses = await prisma.medicationAdministration.findMany({
        where: { medicationOrder: { patientId: { in: patientIds }, encounter: { facilityId: { in: facilityIds } } }, status: { in: ["DUE", "MISSED"] }, scheduledAt: { gte: since, lte: until } },
        orderBy: { scheduledAt: "asc" }, take: 30, select: { id: true, status: true, scheduledAt: true, medicationOrder: { select: { drugName: true, dose: true } } },
      });
      for (const d of doses) {
        if (!ok(d.medicationOrder.drugName)) continue;
        out.push({ chunkId: `live:dose:${d.id}`, context: `[Medicine dose · ${d.medicationOrder.drugName} · ${isoDay(d.scheduledAt)} · verified]`, text: `Dose ${d.status === "MISSED" ? "missed" : "due"}: ${d.medicationOrder.drugName} ${d.medicationOrder.dose} at ${d.scheduledAt.toISOString().slice(11, 16)} UTC on ${isoDay(d.scheduledAt)}.`, origin: "VERIFIED", sourceType: "MEDICATION_DOSE", sourceId: d.id, recordedAt: d.scheduledAt });
      }
    }
  }
  if (access.live.allergies) {
    const rows = await prisma.allergy.findMany({
      where: { patientId: { in: patientIds }, patient: { facilityId: { in: facilityIds } }, status: "ACTIVE", ...(access.live.patientProvidedAllergies ? {} : { source: "CLINICIAN" }) },
      orderBy: { recordedAt: "desc" }, take: 20,
    });
    for (const a of rows) {
      const reported = a.source === "PATIENT_PROVIDED";
      out.push({ chunkId: `live:allergy:${a.id}`, context: `[Allergy · ${a.substance} · ${isoDay(a.recordedAt)} · ${reported ? "patient-provided" : "verified"}]`, text: `${reported ? "Patient-reported allergy" : "Allergy"}: ${a.substance}${a.reaction ? `, reaction ${a.reaction}` : ""}${a.severity ? `, ${a.severity.toLowerCase()}` : ", severity not recorded"} (${a.verification.toLowerCase()}).`, origin: reported ? "PATIENT_PROVIDED" : "VERIFIED", sourceType: "ALLERGY", sourceId: a.id, recordedAt: a.recordedAt });
    }
  }
  return out;
}

export async function retrieve(access: AiAccess, input: { question?: string; visitReason?: string; reportSourceIds?: string[] } = {}): Promise<Retrieval> {
  const spec = MODES[access.mode];
  const space = await activeSpace();
  const provider = embeddingProviderFor(space);
  const scope: RetrievalScope = input.reportSourceIds ? { segments: access.scope.segments.map((s) => ({ ...s, sourceIds: input.reportSourceIds })) } : access.scope;
  const query = [input.question, input.visitReason].filter(Boolean).join(" ") || DEFAULT_QUERY[access.mode];
  const terms = contentWords(query);
  const [qv] = await provider.embed([query], "query", access.permit);
  const candidates = await candidateSearch({ scope, space: { model: space.embeddingModel, version: space.embeddingVersion }, queryVector: qv, terms });
  const fused = fuse(candidates).slice(0, 30);
  const rows = new Map((await prisma.ragChunk.findMany({ where: { id: { in: fused.map((f) => f.chunkId) } }, select: CHUNK_SELECT })).map((c) => [c.id, toRow(c)]));
  const top = fused.map((f) => rows.get(f.chunkId)).filter((c): c is ChunkRow => !!c);
  const reranked = provider.rerank ? await provider.rerank(query, top.map((c) => `${c.context}\n${c.text}`), access.permit) : top.map((_, index) => ({ index, score: fused[index].rrf * RRF_K / 2 }));
  const latestIntent = LATEST.test(query);
  const newest = Math.max(0, ...top.map((c) => c.recordedAt.getTime()));
  const oldest = Math.min(...top.map((c) => c.recordedAt.getTime()), newest);
  const scored: RetrievedChunk[] = reranked.map(({ index, score }) => {
    const c = top[index];
    const recency = newest === oldest ? 1 : (c.recordedAt.getTime() - oldest) / (newest - oldest);
    return { ...c, score: score + (latestIntent ? 0.15 * recency : 0) - (c.origin === "PATIENT_PROVIDED" ? 0.02 : 0) };
  });
  // A verified entry beats a patient-provided one on the same footing; then the newer.
  scored.sort((a, b) => b.score - a.score || (a.origin === b.origin ? 0 : a.origin === "VERIFIED" ? -1 : 1) || b.recordedAt.getTime() - a.recordedAt.getTime() || a.chunkId.localeCompare(b.chunkId));
  const topScore = reranked.length ? Math.max(...reranked.map((r) => r.score)) : null;
  let chunks = scored.slice(0, spec.keep);

  if (input.reportSourceIds) {
    // The one report, whole, in order.
    const all = (await prisma.ragChunk.findMany({ where: { id: { in: candidates.map((c) => c.chunkId) } }, select: { ...CHUNK_SELECT, chunkNo: true }, orderBy: [{ sourceId: "asc" }, { chunkNo: "asc" }] })).map((c) => ({ ...toRow(c), score: scored.find((s) => s.chunkId === c.id)?.score ?? 0 }));
    chunks = all.length ? all : chunks;
  }
  if (spec.context) {
    const have = new Set(chunks.map((c) => c.chunkId));
    const vitals = (await contextChunks(scope, ["OBSERVATION"], 1));
    const lists = await contextChunks(scope, ["ALLERGY", "ALLERGY_STATUS", "PROBLEM", "DIAGNOSIS"], 10);
    for (const c of [...vitals, ...lists]) if (!have.has(c.chunkId)) { chunks.push({ ...c, score: 0 }); have.add(c.chunkId); }
  }
  if (access.mode === "HEALTH_TIMELINE") chunks.sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime() || a.chunkId.localeCompare(b.chunkId));
  const live = access.mode === "EXPLAIN_REPORT" ? [] : await liveFacts(access);

  const threshold = await modeThreshold(access.mode, access.callerOrganizationId ?? access.subject.organizationId, access.callerFacilityId ?? access.subject.facilityId);
  const covered = terms.length > 0 && candidates.some((c) => c.matchedTerms >= terms.length);
  const noRecord = input.question
    ? (topScore === null || topScore < threshold) && !covered
    : chunks.length === 0 && live.length === 0;
  return { chunks: noRecord ? [] : chunks, live: noRecord ? [] : live, topScore, threshold, noRecord, space: { model: space.embeddingModel, version: space.embeddingVersion }, candidateIds: candidates.map((c) => c.chunkId) };
}
