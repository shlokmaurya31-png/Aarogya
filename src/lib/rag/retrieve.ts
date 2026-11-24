import { Prisma, type RagOrigin, type RagSourceType } from "@prisma/client";
import { tokenEconomy } from "./economy";
import { countTokens, familyFor } from "./tokens";
import { prisma } from "@/lib/db";
import { resolveEffectiveInternal } from "@/lib/config/resolver";
import { embeddingProviderFor } from "@/lib/ai/embeddings";
import { contentWords } from "@/lib/ai/record/mock";
import { activeSpace } from "./embed";
import { AI_MODES, MODES, type AiMode } from "./modes";
import { candidateSearch, scopeSql } from "./search";
import { candidateCounts } from "./candidates";
import { queryTerms } from "./queryTerms";
import type { AiAccess } from "./access";
import type { RetrievalScope } from "./scope";
import { isoDay } from "./render";
import { sensitiveCategoryOf } from "./sensitivity";
import { routeQuestion, type RetrievalPlan } from "./router";
import { settle } from "./intentModel";
import { runReaders } from "./readers";
import { dedupePassages, dropCoveredByFacts } from "./context";
import { nlemNames } from "@/lib/medicines/reference";
import { canonicalMedicine, MEDICINE_VARIANTS } from "./medicineNames";
import { LEXICON } from "./lexicon";
import { subjectCovered } from "./abstain";

/**
 * Week 4b — retrieval (docs/RAG_DESIGN.md §7). Filters first, in SQL (the
 * access scope from access.ts), then:
 *   1–3  the 40 nearest by exact cosine and the 40 best keyword matches,
 *        fused by reciprocal rank (k = 60);
 *   4    the top 30 reranked (the space's reranker, 0..1), keeping 8 (12 for
 *        the brief, the handoff and the timeline, which also always get the
 *        latest vitals day, the allergy and problem lists, and the live
 *        medicines; the brief and the handoff, the newest result of each
 *        test or study too);
 *   5    ties by recency; "latest", "last" or "current" favour the newest;
 *   6    a verified chunk ranks above a patient-provided one on the same
 *        footing;
 *   7.3  "no record found" when a question's best score (indexed chunks and
 *        live facts alike) is under the mode's threshold and no keyword match
 *        covered the question — the model is then not asked;
 *   7.4  live facts: active medicines (and, for a nurse, doses due or missed)
 *        and the active allergy list, read now, cited by id.
 *
 * RAG Phase 3 (docs/RAG_IMPLEMENTATION_PLAN.md §5): a question in chart Q&A
 * is routed first (router.ts). A structured lookup that its readers answer
 * in full (readers.ts) is answered from the authoritative tables with no
 * vector or keyword search; a mixed question gets the readers' facts first
 * and the passages after, minus any passage about the same row; anything
 * else, and any lookup a reader can't answer, gets the full hybrid search as
 * before. Passages are deduplicated, and a kept passage brings its
 * neighbours under the same heading (context.ts). An imported passage never
 * gets the "latest" boost and ranks below a verified one.
 */
export interface RetrievedChunk {
  chunkId: string; documentId: string; context: string; heading: string | null; text: string;
  origin: RagOrigin; sourceType: RagSourceType; sourceId: string; recordedAt: Date; handwritten: boolean;
  translatedText: string | null; translationLanguage: string | null;
  score: number;
}

export interface LiveFact {
  /** "live:<kind>:<id>" — cited like a chunk. */
  chunkId: string; context: string; text: string; origin: RagOrigin; sourceType: string; sourceId: string; recordedAt: Date;
}

export interface Retrieval {
  /** RAG Phase 3: the readers' facts and the live facts the question asked for, given to the model first. */
  structured: LiveFact[];
  chunks: RetrievedChunk[];
  live: LiveFact[];
  plan: RetrievalPlan | null;
  /** A structured lookup answered by its readers: no vector or keyword search ran. */
  answeredByReader: boolean;
  /** OPERATIONAL or UNSUPPORTED: not answered in this mode (operational readers come later). */
  unsupported: boolean;
  topScore: number | null;
  threshold: number;
  noRecord: boolean;
  space: { model: string; version: number };
  candidateIds: string[];
  /** RAG Phase 4: what the retrieval cost (no text). */
  usage: RetrievalUsage;
}

/** Query-embedding tokens (the space's provider family), rerank units (documents scored), and retrieval passes. */
export interface RetrievalUsage { embeddingTokens: number; rerankUnits: number; iterations: number }

/** RAG Phase 4: retrieval passes at most for one question (ai.retrieval.max_iterations). */
async function maxRetrievalIterations(organizationId: string | null, facilityId: string | null): Promise<number> {
  if (!organizationId) return 1;
  const eff = await resolveEffectiveInternal({ key: "ai.retrieval.max_iterations", organizationId, facilityId: facilityId ?? undefined, fallbackRaw: "1" });
  return typeof eff.value === "number" ? eff.value : 1;
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
  KNOWLEDGE_QA: "",
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

let medicineWords: Set<string> | null = null;
/**
 * The router's medicine entity: one-word NLEM names, their other names (3.5),
 * and the lexicon's medicine names in every script (3.10), lower case.
 */
function medicines(): Set<string> {
  medicineWords ??= new Set([
    ...nlemNames().map((n) => n.toLowerCase()).filter((n) => /^[a-z][a-z-]+$/.test(n)),
    ...Object.entries(MEDICINE_VARIANTS).flatMap(([k, vs]) => [k, ...vs]).filter((n) => !n.includes(" ")),
    ...LEXICON.filter((c) => c.kind === "MEDICINE").flatMap((c) => Object.values(c.names).flat()).map((n) => n!.toLowerCase().normalize("NFC")).filter((n) => !n.includes(" ")),
  ]);
  return medicineWords;
}

/** A medicine word as the name the record writes (the INN): a variant's INN, or the lexicon concept's English name. */
function medicineName(word: string): string {
  const w = word.toLowerCase().normalize("NFC");
  const concept = LEXICON.find((c) => c.kind === "MEDICINE" && Object.values(c.names).some((ns) => ns!.some((n) => n.toLowerCase().normalize("NFC") === w)));
  return canonicalMedicine(w) ?? concept?.names.en?.[0] ?? w;
}

/** The plan for a chart question (null for every other request: those keep their whole-record retrieval). */
async function planFor(access: AiAccess, question: string | undefined): Promise<RetrievalPlan | null> {
  if (!question || access.mode !== "CHART_QA") return null;
  const p = await settle(routeQuestion(question, access.mode, { medicines: medicines() }), { question, mode: access.mode }, access.permit);
  // Knowledge isn't searched from a chart in this phase (plan step 6.1): the record's passages answer.
  return p.intent === "KNOWLEDGE" ? { ...p, intent: "NARRATIVE", semantic: true, keyword: true, readers: [] } : p;
}

/** The live facts a plan asked for: allergies; medicines (only the one named, if any). */
function askedLive(live: LiveFact[], plan: RetrievalPlan): LiveFact[] {
  const med = plan.entities.medicine ? medicineName(plan.entities.medicine) : undefined;
  return live.filter((l) => (plan.readers.includes("ALLERGIES") && l.sourceType === "ALLERGY")
    || (plan.readers.includes("MEDICINES") && (l.sourceType === "MEDICATION_ORDER" || l.sourceType === "MEDICATION_DOSE") && (!med || l.text.toLowerCase().includes(med))));
}
const CHUNK_SELECT = { id: true, documentId: true, context: true, heading: true, text: true, origin: true, sourceType: true, sourceId: true, recordedAt: true, handwritten: true, translatedText: true, translationLanguage: true } as const;
const toRow = (c: { id: string } & Omit<ChunkRow, "chunkId">): ChunkRow => ({ chunkId: c.id, documentId: c.documentId, context: c.context, heading: c.heading, text: c.text, origin: c.origin, sourceType: c.sourceType, sourceId: c.sourceId, recordedAt: c.recordedAt, handwritten: c.handwritten, translatedText: c.translatedText, translationLanguage: c.translationLanguage });

/** The newest chunk of each title (test or study name), newest first, at most `n`. */
function latestPerTitle(rows: ChunkRow[], n: number): ChunkRow[] {
  const seen = new Set<string>();
  const out: ChunkRow[] = [];
  for (const r of [...rows].sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())) {
    const title = r.context.split(" · ")[1] ?? r.context;
    if (seen.has(title)) continue;
    seen.add(title);
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

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
    const { from, to } = access.live.period ?? {};
    for (const o of orders) {
      if (!ok(`${o.drugName} ${o.genericName ?? ""}`)) continue;
      // Week 4c: a share's period limits the live medicines too.
      if ((from && o.orderedAt < from) || (to && o.orderedAt > to)) continue;
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
      // Week 4c: a sensitive allergy follows the scope's opt-ins like everything else.
      if (!ok(`${a.substance} ${a.reaction ?? ""}`)) continue;
      const reported = a.source === "PATIENT_PROVIDED";
      out.push({ chunkId: `live:allergy:${a.id}`, context: `[Allergy · ${a.substance} · ${isoDay(a.recordedAt)} · ${reported ? "patient-provided" : "verified"}]`, text: `${reported ? "Patient-reported allergy" : "Allergy"}: ${a.substance}${a.reaction ? `, reaction ${a.reaction}` : ""}${a.severity ? `, ${a.severity.toLowerCase()}` : ", severity not recorded"} (${a.verification.toLowerCase()}).`, origin: reported ? "PATIENT_PROVIDED" : "VERIFIED", sourceType: "ALLERGY", sourceId: a.id, recordedAt: a.recordedAt });
    }
  }
  return out;
}

export async function retrieve(access: AiAccess, input: { question?: string; visitReason?: string; reportSourceIds?: string[] } = {}): Promise<Retrieval> {
  const spec = MODES[access.mode];
  const space = await activeSpace();
  const threshold0 = () => modeThreshold(access.mode, access.callerOrganizationId ?? access.subject.organizationId, access.callerFacilityId ?? access.subject.facilityId);
  const spaceRef = { model: space.embeddingModel, version: space.embeddingVersion };
  // RAG Phase 4, step 4.5: what this retrieval cost (no text): the query embedding's tokens, rerank units, passes.
  const usage: RetrievalUsage = { embeddingTokens: 0, rerankUnits: 0, iterations: 1 };

  // RAG Phase 3: route the question; a lookup its readers answer in full needs no search.
  const plan = input.reportSourceIds ? null : await planFor(access, input.question);
  if (plan && (plan.intent === "OPERATIONAL" || plan.intent === "UNSUPPORTED")) {
    return { structured: [], chunks: [], live: [], plan, answeredByReader: false, unsupported: true, topScore: null, threshold: await threshold0(), noRecord: true, space: spaceRef, candidateIds: [], usage };
  }
  const allLive = access.mode === "EXPLAIN_REPORT" ? [] : await liveFacts(access);
  let structured: LiveFact[] = [];
  if (plan && plan.readers.length) {
    const facts = await runReaders(access, plan);
    const asked = askedLive(allLive, plan);
    const answered = plan.readers.every((r) => (r === "ALLERGIES" || r === "MEDICINES" ? asked.length > 0 : facts.some((f) => f.reader === r)));
    structured = [...facts.map(({ reader: _r, ...f }) => f), ...asked];
    if (plan.intent === "STRUCTURED_LOOKUP" && answered) {
      return { structured, chunks: [], live: [], plan, answeredByReader: true, unsupported: false, topScore: null, threshold: await threshold0(), noRecord: false, space: spaceRef, candidateIds: [], usage };
    }
  }
  const provider = embeddingProviderFor(space);
  // RAG Phase 3: a period the question names narrows every segment (never widens it: the later start, the earlier end).
  const asked = plan?.entities.period;
  const later = (a?: Date, b?: Date) => (a && b ? (a > b ? a : b) : a ?? b);
  const earlier = (a?: Date, b?: Date) => (a && b ? (a < b ? a : b) : a ?? b);
  const scope: RetrievalScope = input.reportSourceIds ? { segments: access.scope.segments.map((s) => ({ ...s, sourceIds: input.reportSourceIds })) }
    : asked ? { segments: access.scope.segments.map((s) => ({ ...s, recordedFrom: later(s.recordedFrom, asked.from), recordedTo: earlier(s.recordedTo, asked.to) })) } : access.scope;
  const query = [input.question, input.visitReason].filter(Boolean).join(" ") || DEFAULT_QUERY[access.mode];
  const terms = contentWords(query);
  // RAG Phase 3, step 3.1: the candidate counts from the configuration.
  const counts = await candidateCounts(access.callerOrganizationId ?? access.subject.organizationId, access.callerFacilityId ?? access.subject.facilityId);
  const [qv] = await provider.embed([query], "query", access.permit);
  usage.embeddingTokens = countTokens(query, familyFor(space.embeddingModel));
  const threshold = await threshold0();
  const latestIntent = LATEST.test(query);
  // RAG Phase 4: adaptive retrieval. A near miss (the question would be "no record": best score below the threshold
  // but within 0.1 of it, no candidate holding every term, no reader's fact) is followed by one pass over a wider
  // candidate pool, never a wider scope, up to ai.retrieval.max_iterations; the better pass is kept. The query is
  // embedded once. Any other question pays for one pass only. Default one pass (the registry key explains why).
  const pass = async (mult: number) => {
    const c = { vector: Math.min(200, counts.vector * mult), keyword: Math.min(200, counts.keyword * mult), rerank: Math.min(100, counts.rerank * mult) };
    const candidates = await candidateSearch({ scope, space: { model: space.embeddingModel, version: space.embeddingVersion }, queryVector: qv, terms, keyword: queryTerms(query), vectorLimit: c.vector, keywordLimit: c.keyword });
    const fused = fuse(candidates).slice(0, c.rerank);
    const rows = new Map((await prisma.ragChunk.findMany({ where: { id: { in: fused.map((f) => f.chunkId) } }, select: CHUNK_SELECT })).map((r) => [r.id, toRow(r)]));
    const top = fused.map((f) => rows.get(f.chunkId)).filter((r): r is ChunkRow => !!r);
    const reranked = provider.rerank ? await provider.rerank(query, top.map((r) => `${r.context}\n${r.text}`), access.permit) : top.map((_, index) => ({ index, score: fused[index].rrf * RRF_K / 2 }));
    usage.rerankUnits += provider.rerank ? top.length : 0;
    const topScore = reranked.length ? Math.max(...reranked.map((r) => r.score)) : null;
    const covered = terms.length > 0 && candidates.some((x) => x.matchedTerms >= terms.length);
    return { candidates, top, reranked, topScore, covered, full: candidates.length >= Math.min(c.vector, c.keyword) };
  };
  const maxIterations = await maxRetrievalIterations(access.callerOrganizationId ?? access.subject.organizationId, access.callerFacilityId ?? access.subject.facilityId);
  let best0 = await pass(1);
  const nearMiss = (p: typeof best0) => !p.covered && structured.length === 0 && (p.topScore ?? -1) < threshold && (p.topScore ?? -1) >= threshold - 0.1 && p.full;
  for (let k = 2; k <= maxIterations && input.question && tokenEconomy() && nearMiss(best0); k++) {
    const next = await pass(k);
    usage.iterations = k;
    if ((next.topScore ?? -1) > (best0.topScore ?? -1)) best0 = next;
  }
  const { candidates, top, reranked, topScore } = best0;
  const newest = Math.max(0, ...top.map((c) => c.recordedAt.getTime()));
  const oldest = Math.min(...top.map((c) => c.recordedAt.getTime()), newest);
  const scored: RetrievedChunk[] = reranked.map(({ index, score }) => {
    const c = top[index];
    const recency = newest === oldest ? 1 : (c.recordedAt.getTime() - oldest) / (newest - oldest);
    // Step 3.6: an imported value never gets the "latest" boost, and ranks below a verified one on the same footing.
    return { ...c, score: score + (latestIntent && c.origin !== "IMPORTED" ? 0.15 * recency : 0) - (c.origin === "PATIENT_PROVIDED" ? 0.02 : c.origin === "IMPORTED" ? 0.04 : 0) };
  });
  // Verified above imported above patient-provided on the same footing; then the newer.
  const ORIGIN_RANK = { VERIFIED: 0, IMPORTED: 1, PATIENT_PROVIDED: 2 } as const;
  scored.sort((a, b) => b.score - a.score || ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] || b.recordedAt.getTime() - a.recordedAt.getTime() || a.chunkId.localeCompare(b.chunkId));
  // Step 3.7: a passage about a row a reader already gave is dropped; the same words twice are one passage.
  let chunks = dedupePassages(dropCoveredByFacts(scored, structured)).slice(0, spec.context ? counts.keepContext : counts.keep);

  if (input.reportSourceIds) {
    // The one report, whole, in order.
    const all = (await prisma.ragChunk.findMany({ where: { id: { in: candidates.map((c) => c.chunkId) } }, select: { ...CHUNK_SELECT, chunkNo: true }, orderBy: [{ sourceId: "asc" }, { chunkNo: "asc" }] })).map((c) => ({ ...toRow(c), score: scored.find((s) => s.chunkId === c.id)?.score ?? 0 }));
    chunks = all.length ? all : chunks;
  }
  if (spec.context) {
    const have = new Set(chunks.map((c) => c.chunkId));
    const vitals = (await contextChunks(scope, ["OBSERVATION"], 1));
    const lists = await contextChunks(scope, ["ALLERGY", "ALLERGY_STATUS", "PROBLEM", "DIAGNOSIS"], 10);
    // The brief's and the handoff's objective section: the newest result of each test or study.
    const results = access.mode === "HEALTH_TIMELINE" ? [] : latestPerTitle(await contextChunks(scope, ["LAB_RESULT", "IMAGING_REPORT"], 40), 8);
    for (const c of [...vitals, ...lists, ...results]) if (!have.has(c.chunkId)) { chunks.push({ ...c, score: 0 }); have.add(c.chunkId); }
  }
  if (!input.reportSourceIds) chunks = await withNeighbours(scope, chunks);
  if (access.mode === "HEALTH_TIMELINE") chunks.sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime() || a.chunkId.localeCompare(b.chunkId));
  const given = new Set(structured.map((f) => f.chunkId));
  const live = allLive.filter((l) => !given.has(l.chunkId));
  // Live facts are evidence too ("Is she on warfarin?" never depends on the index, §7.4): scored by the same reranker.
  const liveScores = input.question && live.length && provider.rerank ? await provider.rerank(query, live.map((l) => `${l.context}\n${l.text}`), access.permit) : [];
  usage.rerankUnits += liveScores.length;
  const best = Math.max(topScore ?? -1, ...liveScores.map((x) => x.score));

  const covered = best0.covered;
  // A reader's fact is evidence of its own: a mixed question with facts is never "no record".
  // RAG Phase 5, step 3b: no reader's fact and the subject isn't in the evidence ("HIV status?" over a diagnosis's status line):
  // "no record", whatever the score (abstain.ts).
  const subjectMissing = !!input.question && structured.length === 0
    && subjectCovered(input.question, [...chunks.map((c) => `${c.context}\n${c.text}`), ...live.map((l) => `${l.context}\n${l.text}`)]) === false;
  const noRecord = input.question
    ? ((best < threshold) && !covered && structured.length === 0) || subjectMissing
    : chunks.length === 0 && live.length === 0;
  return {
    structured: noRecord ? [] : structured, chunks: noRecord ? [] : chunks, live: noRecord ? [] : live, plan, answeredByReader: false, unsupported: false,
    topScore: best >= 0 ? best : null, threshold, noRecord, space: spaceRef, candidateIds: fuse(candidates).map((c) => c.chunkId), usage,
  };
}

/**
 * Step 3.7 (3): a kept passage that continues under the same heading brings
 * its neighbours (chunk ±1 of the same document), inside the same scope
 * filter, right after it; at most four are added.
 */
async function withNeighbours(scope: RetrievalScope, chunks: RetrievedChunk[]): Promise<RetrievedChunk[]> {
  if (!chunks.length) return chunks;
  const kept = await prisma.ragChunk.findMany({ where: { id: { in: chunks.map((c) => c.chunkId) } }, select: { id: true, documentId: true, chunkNo: true, heading: true } });
  const wanted = kept.filter((k) => k.heading).flatMap((k) => [k.chunkNo - 1, k.chunkNo + 1].filter((n) => n >= 0).map((n) => ({ anchor: k, n })));
  if (!wanted.length) return chunks;
  const pairs = Prisma.join(wanted.map((w) => Prisma.sql`(${w.anchor.documentId}, ${w.n}::int)`), ", ");
  const rows = await prisma.$queryRaw<{ id: string; documentId: string; chunkNo: number; heading: string | null }[]>(Prisma.sql`
    SELECT c."id", c."documentId", c."chunkNo", c."heading" FROM "RagChunk" c
    WHERE ${scopeSql(scope)} AND (c."documentId", c."chunkNo") IN (${pairs})`);
  const have = new Set(chunks.map((c) => c.chunkId));
  const add = rows.filter((r) => !have.has(r.id) && wanted.some((w) => w.anchor.documentId === r.documentId && w.anchor.heading === r.heading && Math.abs(w.anchor.chunkNo - r.chunkNo) === 1)).slice(0, 4);
  if (!add.length) return chunks;
  const full = new Map((await prisma.ragChunk.findMany({ where: { id: { in: add.map((a) => a.id) } }, select: CHUNK_SELECT })).map((c) => [c.id, toRow(c)]));
  const out: RetrievedChunk[] = [];
  for (const c of chunks) {
    out.push(c);
    const anchor = kept.find((k) => k.id === c.chunkId);
    for (const a of add) if (anchor && a.documentId === anchor.documentId && full.has(a.id) && !out.some((o) => o.chunkId === a.id)) out.push({ ...full.get(a.id)!, score: c.score - 0.001 });
  }
  return out;
}
