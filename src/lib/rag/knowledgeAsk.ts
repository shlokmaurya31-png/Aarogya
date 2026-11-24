import { subjectCovered } from "./abstain";
import { answerWithFailover, routeAnswer, type AnswerRoute } from "@/lib/ai/record/registry";
import { assertTokenBudget, checkTokenBudgetAlerts, TOKEN_BUDGET_MESSAGE, TokenBudgetExceededError } from "./tokenBudget";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { resolveEffectiveInternal } from "@/lib/config/resolver";
import { roleHasPermission } from "@/lib/auth/permissions";
import { knowledgePermit } from "@/lib/ai/realData";
import { embeddingProviderFor, EmbeddingUnavailableError } from "@/lib/ai/embeddings";
import { RecordAiUnavailableError, type AnswerSentence, type RecordSource } from "@/lib/ai/record";
import { mockRecordAnswer, contentWords } from "@/lib/ai/record/mock";
import type { AiActor } from "./access";
import { AskError, checkLimits, holdSlot, type AskHooks, type AskMeta, type AskResult, type Citation, type Label, type OutSentence, type Outcome } from "./ask";
import { ADVISORY_LABEL } from "./modes";
import { phrase } from "./phrases";
import { activeSpace } from "./embed";
import { candidateCounts } from "./candidates";
import { modeThreshold } from "./retrieve";
import { routeQuestion } from "./router";
import { settle } from "./intentModel";
import { knowledgeClassesFor } from "./knowledgeAccess";
import { hitsFor, knowledgeNeighbours, searchKnowledge, type KnowledgeHit, type KnowledgeScope } from "./knowledgeSearch";
import { dedupePassages } from "./context";
import { checkSentence, type SourceText } from "./validate";
import { stem } from "./stem";
import { logInteraction, logRateLimited } from "./interactions";
import { BudgetError } from "./budget";
import { tokenEconomy } from "./economy";
import { prepareSources, usageOf, type Prepared } from "./prepare";
import { estimateCostMicroUsd, priceTable } from "./prices";
import { dropRetrievalCache, readRetrievalCache, retrievalKey, writeRetrievalCache } from "./retrievalCache";
import { countTokens, familyFor } from "./tokens";

/**
 * RAG Phase 3, step 3.4 — KNOWLEDGE_QA (docs/RAG_ARCHITECTURE.md §5.1): a
 * staff member asks about the hospital's approved documents, and the answer
 * cites them. No patient is involved, ever:
 *   - ai:knowledge:ask (every facility staff role), the facility's AI switch,
 *     and the role's access classes (knowledgeAccess.ts);
 *   - only the caller's organisation's documents, for their facility or the
 *     whole organisation, of those classes, and only a version in force now
 *     (published, effective, not expired, superseded or withdrawn): every
 *     condition inside the SQL (knowledgeSearch.ts). The search reads only
 *     ownerType KNOWLEDGE rows, so no patient or person row can be a source;
 *   - an operational question, or one about a patient, isn't answered here;
 *   - "not in the documents" below the mode's threshold, without a model;
 *   - a facility's own document ranks above an organisation-wide one, and a
 *     policy above a guideline note, on the same footing (small, measured);
 *   - every sentence validated like a record answer; each fact labelled
 *     "approved document". The answer comes from the configured answer
 *     provider only if the organisation allows its knowledge text to go to an
 *     external provider (ai.knowledge.external_providers, default off);
 *     otherwise the deterministic extractive answerer quotes the passages.
 */
export interface KnowledgeAskRequest { question: string; language?: string }
/** The route's refusals, re-exported so it reaches the record gateway only through this one. */
export { AskError };

const TYPE_AUTHORITY: Record<string, number> = { POLICY: 0.02, SOP: 0.015, FORMULARY: 0.01, CLINICAL_REFERENCE: 0.01, ADMIN: 0.005, EDUCATIONAL: 0 };

interface KSource { n: number; hit: KnowledgeHit; context: string }

export async function askKnowledge(actor: Extract<AiActor, { kind: "STAFF" }>, req: KnowledgeAskRequest, hooks: AskHooks = {}): Promise<AskResult> {
  const started = Date.now();
  try {
    await checkLimits(actor);
  } catch (err) {
    if (err instanceof AskError && err.status === 429) await logRateLimited(actor, "KNOWLEDGE_QA");
    throw err;
  }
  const release = holdSlot(actor.userId);
  try {
    return await run(actor, req, hooks, started);
  } finally {
    release();
  }
}

async function run(actor: Extract<AiActor, { kind: "STAFF" }>, req: KnowledgeAskRequest, hooks: AskHooks, started: number): Promise<AskResult> {
  const question = (req.question ?? "").trim();
  if (!question) throw new AskError(400, "QUESTION_REQUIRED");
  if (!roleHasPermission(actor.role, "ai:knowledge:ask")) throw new AskError(403, "MODE_NOT_ALLOWED");
  const facility = await prisma.facility.findUnique({ where: { id: actor.facilityId }, select: { organizationId: true } });
  if (!facility) throw new AskError(403, "NO_FACILITY");
  const organizationId = facility.organizationId;
  const enabled = await resolveEffectiveInternal({ key: "ai.enabled", organizationId, facilityId: actor.facilityId, fallbackRaw: "false" });
  if (enabled.value !== true) throw new AskError(403, "AI_NOT_ENABLED");
  const classes = knowledgeClassesFor(actor.role);
  if (!classes.length) throw new AskError(403, "MODE_NOT_ALLOWED");
  const language = req.language && /^[a-z]{2}$/.test(req.language) ? req.language : "en";
  const permit = knowledgePermit(organizationId);
  const space = await activeSpace();
  const interactionId = randomUUID();
  const meta: AskMeta = { interactionId, mode: "KNOWLEDGE_QA", label: ADVISORY_LABEL, language };
  await hooks.onMeta?.(meta);

  const access = { callerOrganizationId: organizationId, callerFacilityId: actor.facilityId, subject: { patientId: null, personId: null } };
  const timing: { retrievalMs: number | null; generationMs: number | null; provider: string | null; tier: number } = { retrievalMs: null, generationMs: null, provider: null, tier: 0 };
  // RAG Phase 4, step 4.5: what the request cost (no text).
  const usage = { embeddingTokens: 0, rerankUnits: 0, cacheHits: 0 };
  let prepared: Prepared | null = null;
  let intent = "KNOWLEDGE";
  const finish = async (outcome: Outcome, sentences: OutSentence[], sources: KSource[], extra: { topScore?: number | null; threshold?: number | null; model?: string; inputTokens?: number; outputTokens?: number; retrieved?: string[] } = {}): Promise<AskResult> => {
    const citedNs = new Set(sentences.flatMap((s) => s.citations));
    const cited = sources.filter((s) => citedNs.has(s.n));
    const tier = timing.provider && timing.provider !== "extractive" ? timing.tier : 0;
    const cost = estimateCostMicroUsd(await priceTable(organizationId), { model: extra.model ?? "none", pricedAs: tier ? prepared?.model : undefined, inputTokens: extra.inputTokens ?? 0, outputTokens: extra.outputTokens ?? 0, embeddingModel: space.embeddingModel, embeddingTokens: usage.embeddingTokens, rerankUnits: usage.rerankUnits });
    await logInteraction({
      id: interactionId, actor, access, mode: "KNOWLEDGE_QA", language, question, space: { model: space.embeddingModel, version: space.embeddingVersion }, started,
      outcome, answerText: sentences.map((s) => s.text).join("\n"), retrievedChunkIds: extra.retrieved ?? sources.map((s) => s.hit.chunkId), citedChunkIds: cited.map((s) => s.hit.chunkId),
      topScore: extra.topScore ?? null, threshold: extra.threshold ?? null, model: extra.model ?? "none", inputTokens: extra.inputTokens ?? 0, outputTokens: extra.outputTokens ?? 0,
      sources: sources.map((s) => ({ rank: s.n, cited: citedNs.has(s.n), chunkId: s.hit.chunkId, ragDocumentId: s.hit.ragDocumentId, sourceType: "KNOWLEDGE_DOCUMENT", sourceId: s.hit.knowledgeDocumentId, origin: "VERIFIED", recordedAt: s.hit.publishedAt ?? new Date(0), pageNumber: s.hit.pageNumber, sectionPath: s.hit.sectionPath })),
      accounting: { module: hooks.module ?? "ASK", intent: `KNOWLEDGE_QA:${intent}`, tier, provider: timing.provider, retrievalMs: timing.retrievalMs, generationMs: timing.generationMs, ...usage, estimatedCostMicroUsd: cost },
    });
    // RAG Phase 5, step 3f: the 80% and 100% alerts, once per facility per 24 hours.
    if (extra.inputTokens || extra.outputTokens) await checkTokenBudgetAlerts(actor.facilityId);
    for (const s of sentences) await hooks.onSentence?.(s);
    return {
      meta, sentences, outcome, trace: { intent, readers: [], confidence: "RULE", answeredByReader: false, tier, iterations: 1, inputTokens: extra.inputTokens ?? 0, ...(prepared ? { budget: prepared.budget.maxInput, dropped: prepared.dropped } : {}) },
      citations: cited.map((s): Citation => ({
        n: s.n, chunkId: s.hit.chunkId, sourceType: "KNOWLEDGE_DOCUMENT", sourceId: s.hit.knowledgeDocumentId, origin: "VERIFIED", translated: language !== "en", handwritten: false,
        recordedAt: (s.hit.publishedAt ?? new Date(0)).toISOString(), title: s.context.replace(/^\[|\]$/g, ""), link: `/hospital-os/knowledge?document=${s.hit.knowledgeDocumentId}`,
      })),
    };
  };
  const guidance = (key: Parameters<typeof phrase>[1]): OutSentence => ({ text: phrase(language, key), citations: [], labels: [], kind: "GUIDANCE" });

  // Route: operational questions and questions about a patient aren't answered here.
  const plan = await settle(routeQuestion(question, "KNOWLEDGE_QA"), { question, mode: "KNOWLEDGE_QA" }, permit);
  intent = plan.intent;
  if (plan.intent !== "KNOWLEDGE") return finish("NO_RECORD", [guidance("noRecord")], []);

  const scope: KnowledgeScope = { organizationId, facilityId: actor.facilityId, accessClasses: classes };
  const counts = await candidateCounts(organizationId, actor.facilityId);
  let hits: KnowledgeHit[] | null = null;
  let best = -1;
  const r0 = Date.now();
  try {
    // RAG Phase 4, step 4.4: the retrieval cache, keyed by everything access depends on (retrievalCache.ts); a hit is
    // re-read through the scope and in-force SQL, and one that no longer passes it whole is dropped and retrieved afresh.
    const keyHash = tokenEconomy() ? await retrievalKey({ scope, userId: actor.userId, role: actor.role, space: { model: space.embeddingModel, version: space.embeddingVersion }, counts, question }) : null;
    const cached = keyHash ? await readRetrievalCache(keyHash) : null;
    if (cached && keyHash) {
      const again = await hitsFor(scope, cached.chunkIds.map((chunkId, i) => ({ chunkId, score: cached.scores[i] })));
      if (again.length === cached.chunkIds.length) { hits = again; best = cached.topScore; usage.cacheHits++; }
      else await dropRetrievalCache(keyHash);
    }
    if (!hits) {
      const stats = { embeddingHits: 0, embedded: 0 };
      let found = await searchKnowledge(scope, question, { limit: counts.rerank, vectorLimit: counts.vector, keywordLimit: counts.keyword, stats });
      usage.cacheHits += stats.embeddingHits;
      usage.embeddingTokens = stats.embedded ? countTokens(question, familyFor(space.embeddingModel)) : 0;
      const provider = embeddingProviderFor(space);
      const reranked = found.length && provider.rerank ? await provider.rerank(question, found.map((h) => `${h.title}\n${h.sectionPath ?? ""}\n${h.text}`), permit) : found.map((h, index) => ({ index, score: h.score * 30 }));
      usage.rerankUnits = provider.rerank ? found.length : 0;
      best = reranked.length ? Math.max(...reranked.map((r) => r.score)) : -1;
      found = reranked.map(({ index, score }) => ({ ...found[index], score: score + (found[index].facilityWide ? 0 : 0.02) + (TYPE_AUTHORITY[found[index].documentType] ?? 0) }))
        .sort((a, b) => b.score - a.score || (a.facilityWide === b.facilityWide ? 0 : a.facilityWide ? 1 : -1) || a.chunkId.localeCompare(b.chunkId));
      hits = found;
      if (keyHash) await writeRetrievalCache(keyHash, { organizationId, facilityId: actor.facilityId, userId: actor.userId }, { chunkIds: found.map((h) => h.chunkId), scores: found.map((h) => h.score), topScore: best });
    }
  } catch (err) {
    if (err instanceof EmbeddingUnavailableError) throw new AskError(503, "PROVIDER_UNAVAILABLE");
    throw err;
  }
  timing.retrievalMs = Date.now() - r0;
  if (!hits) hits = [];
  const threshold = await modeThreshold("KNOWLEDGE_QA", organizationId, actor.facilityId);
  // "Covered": some passage holds every content word of the question (stemmed), as for the record's keyword match.
  const terms = contentWords(question).map(stem);
  const covered = terms.length > 0 && hits.some((h) => { const t = `${h.title} ${h.sectionPath ?? ""} ${h.text}`.toLowerCase(); return terms.every((w) => t.includes(w)); });
  // RAG Phase 5, step 3b: the question's subject must be in the passages (abstain.ts), or "no record" before a wrong answer.
  const subjectMissing = subjectCovered(question, hits.map((h) => `${h.title}\n${h.sectionPath ?? ""}\n${h.text}`)) === false;
  if (!hits.length || (best < threshold && !covered) || subjectMissing) return finish("NO_RECORD", [guidance("noRecord")], [], { topScore: best >= 0 ? best : null, threshold, retrieved: hits.map((h) => h.chunkId) });

  // Context: the kept passages, deduplicated, each followed by its neighbours in the same section.
  let kept = dedupePassages(hits).slice(0, counts.keep);
  const near = await knowledgeNeighbours(scope, kept);
  const have = new Set(kept.map((k) => k.chunkId));
  const extra = near.filter((x) => !have.has(x.chunkId)).slice(0, 4);
  if (extra.length) {
    const more = await searchKnowledgeByIds(extra.map((x) => x.chunkId), kept);
    const out: KnowledgeHit[] = [];
    for (const k of kept) { out.push(k); for (const m of more) if (m.ragDocumentId === k.ragDocumentId && Math.abs(m.chunkNo - k.chunkNo) === 1 && !out.some((o) => o.chunkId === m.chunkId)) out.push({ ...m, score: k.score - 0.001 }); }
    kept = out;
  }
  const sources: KSource[] = kept.map((hit, i) => ({ n: i + 1, hit, context: `[Reference · ${hit.title} · version ${hit.version}${hit.sectionPath ? ` · ${hit.sectionPath}` : ""}${hit.pageNumber ? ` · page ${hit.pageNumber}` : ""} · approved]` }));

  // The answer: the configured provider only where the organisation allows external providers for its knowledge text.
  const external = await resolveEffectiveInternal({ key: "ai.knowledge.external_providers", organizationId, fallbackRaw: "false" });
  // RAG Phase 5: the route by tier and policy (record/registry.ts): Tier 1, or Tier 2 for a high-risk question.
  let route: AnswerRoute;
  try {
    route = routeAnswer({ mode: "KNOWLEDGE_QA", risk: plan.risk, real: false });
  } catch (err) {
    if (err instanceof RecordAiUnavailableError) throw new AskError(503, err.code);
    throw err;
  }
  const externalOk = route.provider.id === "mock" || external.value === true;
  const provider = externalOk ? route.provider : mockRecordAnswer;
  timing.provider = !externalOk ? "extractive" : provider.id;
  timing.tier = route.tier;
  // RAG Phase 5, step 3f: the facility's daily token budget refuses a model call (an extractive answer uses none).
  if (timing.provider !== "extractive") {
    try {
      await assertTokenBudget(actor.facilityId);
    } catch (err) {
      if (!(err instanceof TokenBudgetExceededError)) throw err;
      timing.provider = null;
      await finish("RATE_LIMITED", [], sources, { retrieved: sources.map((s) => s.hit.chunkId) });
      throw new AskError(429, "FACILITY_TOKEN_BUDGET", TOKEN_BUDGET_MESSAGE);
    }
  }
  const all: (RecordSource & { documentId: string })[] = sources.map((s) => ({ n: s.n, chunkId: s.hit.chunkId, context: s.context, text: s.hit.text, documentId: s.hit.ragDocumentId }));
  try {
    prepared = await prepareSources({ mode: "KNOWLEDGE_QA", language, question, providerId: provider.id, model: route.model, organizationId, facilityId: actor.facilityId, sources: all });
  } catch (err) {
    if (err instanceof BudgetError) throw new AskError(400, err.code);
    throw err;
  }
  const provided = prepared.provided;
  const answerReq = { mode: "KNOWLEDGE_QA" as const, audience: "STAFF" as const, language, question, sources: provided };
  const g0 = Date.now();
  let answer;
  try {
    answer = externalOk ? await answerWithFailover(route, answerReq, permit) : await provider.answerFromRecord(answerReq, permit);
    timing.generationMs = Date.now() - g0;
  } catch (err) {
    timing.generationMs = Date.now() - g0;
    if (err instanceof RecordAiUnavailableError) {
      await finish("ERROR", [], sources);
      throw new AskError(503, err.code);
    }
    throw err;
  }
  const used = usageOf(answerReq, answer);
  const extraLog = { topScore: best, threshold, model: answer.model, inputTokens: used.inputTokens, outputTokens: used.outputTokens };
  if (answer.outcome !== "ANSWERED") return finish(answer.outcome === "NO_RECORD" ? "NO_RECORD" : "REFUSED_SAFETY", [guidance(answer.outcome === "NO_RECORD" ? "noRecord" : "askCareTeam")], sources, extraLog);
  // Validated against the original passages the provider was given, never a compressed copy.
  const givenNs = new Set(provided.map((p) => p.n));
  const byN = new Map([...prepared.originals.values()].filter((p) => givenNs.has(p.n)).map((p) => [p.n, { n: p.n, text: p.text, context: p.context } as SourceText]));
  const labels: Label[] = language === "en" ? ["approved document"] : ["approved document", "translated"];
  const out: OutSentence[] = [];
  for (const s of answer.sentences as AnswerSentence[]) {
    if (!checkSentence(s, byN).ok) return finish("CITATION_INVALID", out, sources, extraLog);
    out.push({ text: s.text, citations: s.citations, kind: s.kind, labels: s.kind === "FACT" ? labels : [] });
  }
  return finish("ANSWERED", out, sources, extraLog);
}

/** Neighbour passages (already scope-checked by knowledgeNeighbours), with the fields a source needs. */
async function searchKnowledgeByIds(ids: string[], like: KnowledgeHit[]): Promise<KnowledgeHit[]> {
  const rows = await prisma.ragChunk.findMany({ where: { id: { in: ids }, ownerType: "KNOWLEDGE" }, select: { id: true, documentId: true, chunkNo: true, sourceId: true, pageNumber: true, sectionPath: true, text: true } });
  return rows.flatMap((r) => {
    const sib = like.find((k) => k.ragDocumentId === r.documentId);
    return sib ? [{ ...sib, chunkId: r.id, chunkNo: r.chunkNo, pageNumber: r.pageNumber, sectionPath: r.sectionPath, text: r.text }] : [];
  });
}
