import { prisma } from "@/lib/db";
import { resolveEffectiveInternal } from "@/lib/config/resolver";
import { getRecordAnswerProvider, RecordAiUnavailableError, type AnswerSentence, type RecordSource } from "@/lib/ai/record";
import { identifierSpans, personIdentifiers } from "@/lib/documents/identifiers";
import { EmbeddingUnavailableError } from "@/lib/ai/embeddings";
import { AiAccessError, resolveAiAccess, type AiAccess, type AiActor } from "./access";
import { ADVISORY_LABEL, MODES, type AiMode } from "./modes";
import { phrase } from "./phrases";
import { retrieve, type LiveFact, type RetrievedChunk } from "./retrieve";
import { patientSafety } from "./safety";
import { checkSentence, type SourceText } from "./validate";
import { scopeSql } from "./search";
import { Prisma } from "@prisma/client";
import { logInteraction, logRateLimited } from "./interactions";
import { randomUUID } from "node:crypto";

/**
 * Week 4b — one AI request, end to end (docs/RAG_DESIGN.md §8–§9):
 *   rate limits → access (the resolver; 403/404) → patient safety rules →
 *   retrieval (filters first; "no record" without asking the model) → the
 *   answer provider, given numbered sources with identifiers masked → every
 *   sentence validated (citations retrieved, numbers in the cited sources) →
 *   labels per line (verified / patient-provided / translated / handwritten) →
 *   the interaction logged (metadata; text encrypted only where allowed).
 * Nothing is ever written to the record. A staff answer streams sentence by
 * sentence and stops at the first invalid one; a patient answer is buffered
 * and withheld whole if any sentence fails.
 */
export interface AskRequest {
  mode: AiMode;
  patientId: string;
  shareId?: string;
  documentId?: string;
  appointmentId?: string;
  question?: string;
  period?: { from?: string; to?: string };
  language?: string;
}

export type Outcome = "ANSWERED" | "NO_RECORD" | "REFUSED_SAFETY" | "CITATION_INVALID" | "RATE_LIMITED" | "ERROR";
export type Label = "verified" | "patient-provided" | "translated" | "handwritten" | "not yet confirmed by you";

export interface Citation {
  n: number; chunkId: string; sourceType: string; sourceId: string; origin: "VERIFIED" | "PATIENT_PROVIDED"; translated: boolean; handwritten: boolean;
  recordedAt: string; title: string; link: string;
}
export interface OutSentence { text: string; citations: number[]; labels: Label[]; kind: "FACT" | "GUIDANCE" }
export interface AskMeta { interactionId: string; mode: AiMode; label: string; language: string }
export interface AskResult { meta: AskMeta; sentences: OutSentence[]; citations: Citation[]; outcome: Outcome }

export class AskError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 429 | 503, readonly code: string) {
    super(code);
    this.name = "AskError";
  }
}

// ── Rate limits (§8.3) ─────────────────────────────────────────────────────
export const LIMITS = { STAFF: { perMinute: 20, perDay: 400 }, PATIENT: { perMinute: 6, perDay: 60 }, concurrent: 2 } as const;
const inFlight = new Map<string, number>();

async function checkLimits(actor: AiActor) {
  const who = actor.kind === "STAFF" ? LIMITS.STAFF : LIMITS.PATIENT;
  const now = Date.now();
  const counted = { userId: actor.userId, outcome: { not: "RATE_LIMITED" as const } };
  const [minute, day] = await Promise.all([
    prisma.aiInteraction.count({ where: { ...counted, createdAt: { gte: new Date(now - 60_000) } } }),
    prisma.aiInteraction.count({ where: { ...counted, createdAt: { gte: new Date(now - 86_400_000) } } }),
  ]);
  if (minute >= who.perMinute || day >= who.perDay) throw new AskError(429, "RATE_LIMITED");
  if (actor.kind === "STAFF") {
    const fac = await prisma.facility.findUnique({ where: { id: actor.facilityId }, select: { organizationId: true } });
    if (fac) {
      const eff = await resolveEffectiveInternal({ key: "ai.daily_request_budget", organizationId: fac.organizationId, facilityId: actor.facilityId, fallbackRaw: "2000" });
      const budget = typeof eff.value === "number" ? eff.value : 2000;
      const used = await prisma.aiInteraction.count({ where: { facilityId: actor.facilityId, outcome: { not: "RATE_LIMITED" }, createdAt: { gte: new Date(now - 86_400_000) } } });
      if (used >= budget) throw new AskError(429, "FACILITY_BUDGET");
    }
  }
  if ((inFlight.get(actor.userId) ?? 0) >= LIMITS.concurrent) throw new AskError(429, "TOO_MANY_CONCURRENT");
}

// ── Sources ─────────────────────────────────────────────────────────────────
interface Source { n: number; chunkId: string; context: string; text: string; origin: "VERIFIED" | "PATIENT_PROVIDED"; sourceType: string; sourceId: string; recordedAt: Date; handwritten: boolean; translation?: { language: string; text: string }; unconfirmed?: boolean }

function mask(text: string, ids: readonly string[]): string {
  const spans = identifierSpans(text, ids).sort((a, b) => b.start - a.start);
  let out = text;
  for (const s of spans) out = `${out.slice(0, s.start)}[redacted]${out.slice(s.end)}`;
  return out;
}

async function subjectIdentifiers(access: AiAccess): Promise<string[]> {
  const patients = await prisma.patient.findMany({ where: { id: { in: access.subject.patientIds } }, select: { fullName: true, preferredName: true, uhid: true, phone: true } });
  const fromPerson = access.subject.personId ? await personIdentifiers(access.subject.personId) : [];
  return [...new Set([...fromPerson, ...patients.flatMap((p) => [p.fullName, p.preferredName, p.uhid, p.phone])].filter((x): x is string => !!x && x.trim().length >= 3))];
}

function link(audience: "STAFF" | "PATIENT", patientId: string, s: { sourceType: string; sourceId: string }) {
  return audience === "STAFF" ? `/hospital-os/doctor/patients/${patientId}?entry=${s.sourceType}:${s.sourceId}` : `/patient/records?entry=${s.sourceType}:${s.sourceId}`;
}

/**
 * EXPLAIN_REPORT on the patient's own upload. While its facts await review:
 * its read text, read directly (§2), never from the index, every line
 * "not yet confirmed by you". Once the review is done: null, and the
 * confirmed entries (patient-provided) are explained instead.
 */
async function unconfirmedUpload(access: AiAccess, documentId: string): Promise<Source[] | null> {
  if (access.path !== "OWN" || !access.subject.personId) return null;
  const doc = await prisma.personDocument.findFirst({ where: { id: documentId, personId: access.subject.personId, status: "CURRENT", type: { not: "ID_PROOF" } }, select: { id: true, title: true, uploadedAt: true } });
  if (!doc) return null;
  const run = await prisma.documentProcessing.findFirst({ where: { documentId: doc.id }, orderBy: { run: "desc" }, select: { status: true, texts: { orderBy: { pageNo: "asc" }, select: { pageNo: true, text: true, handwritten: true } } } });
  if (run?.status === "COMPLETED") return null;
  return (run?.texts ?? []).map((t, i) => ({
    n: i + 1, chunkId: `upload:${doc.id}:${t.pageNo}`, context: `[Your uploaded report · ${doc.title} · page ${t.pageNo} · not yet confirmed by you]`, text: t.text,
    origin: "PATIENT_PROVIDED", sourceType: "PATIENT_DOCUMENT", sourceId: doc.id, recordedAt: doc.uploadedAt, handwritten: t.handwritten, unconfirmed: true,
  }));
}

function labelsFor(cited: Source[], answerLanguage: string): Label[] {
  const labels = new Set<Label>();
  for (const c of cited) {
    labels.add(c.origin === "VERIFIED" ? "verified" : "patient-provided");
    if (c.handwritten) labels.add("handwritten");
    if (c.unconfirmed) labels.add("not yet confirmed by you");
  }
  // Sources are English (values as printed); an answer in another language is a translation of them.
  if (answerLanguage !== "en" || cited.some((c) => c.translation)) labels.add("translated");
  return [...labels];
}

// ── The request ─────────────────────────────────────────────────────────────
export interface AskHooks {
  /** Called with each validated sentence as it is released (staff modes stream; patient modes call it after the whole answer passed). */
  onSentence?: (s: OutSentence) => void | Promise<void>;
  onMeta?: (m: AskMeta) => void | Promise<void>;
}

export async function askAi(actor: AiActor, req: AskRequest, hooks: AskHooks = {}): Promise<AskResult> {
  const started = Date.now();
  try {
    await checkLimits(actor);
  } catch (err) {
    // A refused request still leaves its metadata (outcome RATE_LIMITED, no text).
    if (err instanceof AskError && err.status === 429) await logRateLimited(actor, req.mode);
    throw err;
  }
  inFlight.set(actor.userId, (inFlight.get(actor.userId) ?? 0) + 1);
  try {
    return await run(actor, req, hooks, started);
  } finally {
    inFlight.set(actor.userId, Math.max(0, (inFlight.get(actor.userId) ?? 1) - 1));
  }
}

async function run(actor: AiActor, req: AskRequest, hooks: AskHooks, started: number): Promise<AskResult> {
  const spec = MODES[req.mode];
  let access: AiAccess;
  try {
    access = await resolveAiAccess(actor, { mode: req.mode, patientId: req.patientId, shareId: req.shareId, documentId: req.documentId, period: req.period ? { from: req.period.from ? new Date(req.period.from) : undefined, to: req.period.to ? new Date(req.period.to) : undefined } : undefined });
  } catch (err) {
    if (err instanceof AiAccessError) throw new AskError(err.status, err.code);
    throw err;
  }
  if (req.mode === "CHART_QA" && !req.question) throw new AskError(400, "QUESTION_REQUIRED");
  if (req.mode === "EXPLAIN_REPORT" && !req.documentId) throw new AskError(400, "DOCUMENT_REQUIRED");
  if (req.question && req.mode !== "CHART_QA" && req.mode !== "EXPLAIN_REPORT") throw new AskError(400, "QUESTION_NOT_ALLOWED");
  const language = req.language && /^[a-z]{2}$/.test(req.language) ? req.language : spec.audience === "PATIENT" ? (await preferredLanguage(access)) : "en";
  const space = await prisma.ragEmbeddingSpace.findFirstOrThrow({ where: { status: "ACTIVE" } });
  const interactionId = randomUUID();
  const base = { id: interactionId, actor, access, mode: req.mode, language, question: req.question ?? null, space: { model: space.embeddingModel, version: space.embeddingVersion }, started };
  const m: AskMeta = { interactionId, mode: req.mode, label: ADVISORY_LABEL, language };
  // The label and the interaction id go first (§8.2), before any sentence.
  await hooks.onMeta?.(m);

  const finish = async (outcome: Outcome, sentences: OutSentence[], sources: Source[], extra: { topScore?: number | null; threshold?: number | null; model?: string; inputTokens?: number; outputTokens?: number; retrieved?: string[] } = {}): Promise<AskResult> => {
    const citedNs = new Set(sentences.flatMap((s) => s.citations));
    const cited = sources.filter((s) => citedNs.has(s.n));
    await logInteraction({
      ...base, outcome, answerText: sentences.map((s) => s.text).join("\n"), retrievedChunkIds: extra.retrieved ?? sources.map((s) => s.chunkId), citedChunkIds: cited.map((s) => s.chunkId),
      topScore: extra.topScore ?? null, threshold: extra.threshold ?? null, model: extra.model ?? "none", inputTokens: extra.inputTokens ?? 0, outputTokens: extra.outputTokens ?? 0,
    });
    // Staff answers already streamed what passed; everything else is released now, whole.
    if (spec.audience === "PATIENT" || (outcome !== "ANSWERED" && outcome !== "CITATION_INVALID")) for (const s of sentences) await hooks.onSentence?.(s);
    return {
      meta: m, sentences, outcome,
      citations: cited.map((s) => ({ n: s.n, chunkId: s.chunkId, sourceType: s.sourceType, sourceId: s.sourceId, origin: s.origin, translated: !!s.translation || language !== "en", handwritten: s.handwritten, recordedAt: s.recordedAt.toISOString(), title: s.context.replace(/^\[|\]$/g, ""), link: link(spec.audience, access.subject.patientId, s) })),
    };
  };
  const guidance = (key: Parameters<typeof phrase>[1]): OutSentence => ({ text: phrase(language, key), citations: [], labels: [], kind: "GUIDANCE" });

  // Patient safety rules first: an urgent symptom gets the emergency line and nothing else.
  if (spec.audience === "PATIENT") {
    const v = patientSafety(req.question);
    if (v === "URGENT") return finish("REFUSED_SAFETY", [guidance("emergency")], []);
    if (v !== "OK") return finish("REFUSED_SAFETY", [guidance("askCareTeam")], []);
  }

  // The sources.
  let sources: Source[] = [];
  let retrieval: Awaited<ReturnType<typeof retrieve>> | null = null;
  const upload = req.mode === "EXPLAIN_REPORT" && req.documentId ? await unconfirmedUpload(access, req.documentId) : null;
  try {
    if (upload) {
      sources = upload;
      if (!sources.length) return finish("NO_RECORD", [guidance("noRecord")], []);
    } else {
      let reportSourceIds: string[] | undefined;
      if (req.mode === "EXPLAIN_REPORT") {
        // The report must be in the caller's scope, or it doesn't exist for them.
        const n = Number((await prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM "RagChunk" c WHERE ${scopeSql(access.scope)} AND c."sourceId" = ${req.documentId!}`))[0].n);
        if (!n) throw new AskError(404, "NOT_FOUND");
        reportSourceIds = [req.documentId!];
        // The patient's own reviewed upload: its confirmed entries are the report.
        if (access.path === "OWN" && access.subject.personId) {
          const confirmed = await prisma.patientProvidedRecord.findMany({ where: { personId: access.subject.personId, documentId: req.documentId!, status: "ACTIVE" }, select: { id: true } });
          reportSourceIds.push(...confirmed.map((r) => r.id));
        }
      }
      const visitReason = req.appointmentId ? (await prisma.appointment.findFirst({ where: { id: req.appointmentId, patientId: { in: access.subject.patientIds } }, select: { reason: true } }))?.reason ?? undefined : undefined;
      retrieval = await retrieve(access, { question: req.question, visitReason, reportSourceIds });
      if (retrieval.noRecord) return finish("NO_RECORD", [guidance("noRecord")], [], { topScore: retrieval.topScore, threshold: retrieval.threshold, retrieved: retrieval.candidateIds });
      const items: (RetrievedChunk | LiveFact)[] = [...retrieval.chunks, ...retrieval.live];
      sources = items.map((c, i) => ({
        n: i + 1, chunkId: c.chunkId, context: c.context, text: c.text, origin: c.origin, sourceType: c.sourceType, sourceId: c.sourceId, recordedAt: c.recordedAt,
        handwritten: "handwritten" in c ? c.handwritten : false,
        ...("translatedText" in c && c.translatedText && c.translationLanguage === language ? { translation: { language, text: c.translatedText } } : {}),
      }));
    }
  } catch (err) {
    if (err instanceof EmbeddingUnavailableError) throw new AskError(503, "PROVIDER_UNAVAILABLE");
    throw err;
  }

  // Minimum necessary: no name, UHID, phone or ABHA number reaches the provider (§9.7).
  const ids = await subjectIdentifiers(access);
  const provided: RecordSource[] = sources.map((s) => ({ n: s.n, chunkId: s.chunkId, context: mask(s.context, ids), text: mask(s.text, ids), ...(s.translation ? { translation: { language: s.translation.language, text: mask(s.translation.text, ids) } } : {}) }));
  let answer;
  try {
    answer = await getRecordAnswerProvider().answerFromRecord({ mode: req.mode, audience: spec.audience, language, question: req.question, sources: provided }, access.permit);
  } catch (err) {
    if (err instanceof RecordAiUnavailableError) {
      await finish("ERROR", [], sources, { retrieved: sources.map((s) => s.chunkId) });
      throw new AskError(503, err.code);
    }
    throw err;
  }
  const extra = { topScore: retrieval?.topScore ?? null, threshold: retrieval?.threshold ?? null, model: answer.model, inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, retrieved: sources.map((s) => s.chunkId) };
  if (answer.outcome !== "ANSWERED") {
    const line = answer.outcome === "NO_RECORD" ? guidance("noRecord") : guidance("askCareTeam");
    return finish(answer.outcome, [line], sources, extra);
  }

  // Validate, sentence by sentence; label each.
  const byN = new Map(provided.map((p) => [p.n, { n: p.n, text: p.text, context: p.context } as SourceText]));
  const srcByN = new Map(sources.map((s) => [s.n, s]));
  const released: OutSentence[] = [];
  const out: OutSentence[] = upload ? [guidance("unconfirmed")] : [];
  for (const s of answer.sentences as AnswerSentence[]) {
    const check = checkSentence(s, byN);
    if (!check.ok) {
      if (spec.audience === "PATIENT") return finish("CITATION_INVALID", [], sources, extra);
      return finish("CITATION_INVALID", released, sources, extra);
    }
    const os: OutSentence = { text: s.text, citations: s.citations, kind: s.kind, labels: s.kind === "FACT" ? labelsFor(s.citations.map((n) => srcByN.get(n)!), language) : [] };
    out.push(os);
    released.push(os);
    if (spec.audience === "STAFF") await hooks.onSentence?.(os);
  }
  return finish("ANSWERED", out, sources, extra);
}

async function preferredLanguage(access: AiAccess): Promise<string> {
  if (!access.subject.personId) return "en";
  return (await prisma.person.findUnique({ where: { id: access.subject.personId }, select: { preferredLanguage: true } }))?.preferredLanguage ?? "en";
}
