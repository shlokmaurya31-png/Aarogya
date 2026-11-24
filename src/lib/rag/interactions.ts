import type { AiTextReadReason, AiTextScope, RagOrigin } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolveEffectiveInternal } from "@/lib/config/resolver";
import { recordAuditEvent } from "@/lib/auth/audit";
import { NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { roleHasPermission } from "@/lib/auth/permissions";
import type { Role } from "@prisma/client";
import { currentTextKey, decryptText, encryptText } from "./textCrypto";
import type { AiActor, AiAccess } from "./access";
import type { AiMode } from "./modes";

/**
 * Week 4b — AI interactions (docs/RAG_DESIGN.md §3.3, §4.3).
 *   metadata   always: ids, the access path, scores, outcome, tokens, latency;
 *              kept a year
 *   staff text the question and answer, encrypted (AES-256-GCM), kept
 *              ai.staff_text_retention_days (90 at most), for safety review
 *   patient    text only with the person's AI_TEXT_RETENTION opt-in; readable
 *              by reviewers only if the opt-in includes SAFETY_REVIEW
 *   reviewers  the clinical-advisor and safety-officer roles; every read names
 *              a closed reason and a ticket, is logged (AiTextReadLog) and
 *              audited, and appears in the monthly review report
 * No encryption key configured: no text is kept.
 */
const DAY = 86_400_000;
const METADATA_DAYS = 365;

/** Who and what the request was about: an AI access (a patient's record), or (RAG Phase 3) knowledge Q&A, which has no patient. */
export type LoggedAccess = Pick<AiAccess, "callerOrganizationId" | "callerFacilityId" | "shareId" | "consentId"> & { subject: { patientId: string | null; personId: string | null } };

export interface LogInput {
  id: string; actor: AiActor; access: LoggedAccess; mode: AiMode; language: string; question: string | null; answerText: string;
  space: { model: string; version: number }; started: number;
  outcome: "ANSWERED" | "NO_RECORD" | "REFUSED_SAFETY" | "CITATION_INVALID" | "RATE_LIMITED" | "ERROR";
  retrievedChunkIds: string[]; citedChunkIds: string[]; topScore: number | null; threshold: number | null; model: string; inputTokens: number; outputTokens: number;
  /** RAG Phase 1: the sources given to the model (AiInteractionSource rows; no text). */
  sources?: LoggedSource[];
  /** RAG Phase 1: accounting (docs/RAG_ARCHITECTURE.md §11.5). */
  accounting?: {
    module: string; intent: string; tier: number; provider: string | null; retrievalMs: number | null; generationMs: number | null;
    /** RAG Phase 4, step 4.5: query-embedding tokens, rerank units, cache hits (embedding and retrieval), and the estimated cost. */
    embeddingTokens?: number; rerankUnits?: number; cacheHits?: number; estimatedCostMicroUsd?: number;
  };
}

export interface LoggedSource { rank: number; cited: boolean; chunkId: string; ragDocumentId: string | null; sourceType: string; sourceId: string; origin: RagOrigin; recordedAt: Date; pageNumber?: number | null; sectionPath?: string | null }

/** live:<kind>:<id> is a structured reader's fact; upload:<doc>:<page> an unconfirmed upload read directly; anything else an index chunk. */
const sourceKind = (chunkId: string) => (chunkId.startsWith("live:") ? "LIVE" : chunkId.startsWith("upload:") ? "UPLOAD" : "CHUNK");

async function textPolicy(input: LogInput): Promise<{ scope: AiTextScope; days: number } | null> {
  if (input.actor.kind === "STAFF") {
    const org = input.access.callerOrganizationId;
    const eff = org ? await resolveEffectiveInternal({ key: "ai.staff_text_retention_days", organizationId: org, fallbackRaw: "90" }) : null;
    const days = Math.min(90, typeof eff?.value === "number" ? eff.value : 90);
    return { scope: "STAFF_SAFETY", days };
  }
  const personId = input.access.subject.personId;
  if (!personId) return null;
  const c = await prisma.personConsent.findFirst({ where: { personId, purpose: "AI_TEXT_RETENTION", status: "ACTIVE" }, select: { decision: true, scopes: true } });
  if (c?.decision !== "GRANTED") return null;
  return { scope: c.scopes.includes("SAFETY_REVIEW") ? "PATIENT_OPT_IN_SAFETY_REVIEW" : "PATIENT_OPT_IN", days: 90 };
}

export async function logInteraction(input: LogInput): Promise<string> {
  const now = new Date();
  const policy = await textPolicy(input);
  const key = currentTextKey();
  const text = policy && key && (input.question || input.answerText)
    ? { questionCiphertext: encryptText(input.question ?? "", key.key), answerCiphertext: encryptText(input.answerText, key.key), keyVersion: key.version, textScope: policy.scope, textExpiresAt: new Date(now.getTime() + policy.days * DAY - 1000) }
    : {};
  const a = input.access;
  const docIds = [...new Set((input.sources ?? []).map((s) => s.ragDocumentId).filter((x): x is string => !!x))];
  const versions = new Map((docIds.length ? await prisma.ragDocument.findMany({ where: { id: { in: docIds } }, select: { id: true, sourceVersion: true, knowledgeVersionId: true } }) : []).map((d) => [d.id, d]));
  const acc = input.accounting;
  await prisma.aiInteraction.create({
    data: {
      ...(acc ? {
        module: acc.module, intent: acc.intent, tier: acc.tier, provider: acc.provider, retrievalMs: acc.retrievalMs, generationMs: acc.generationMs,
        embeddingTokens: acc.embeddingTokens ?? 0, rerankUnits: acc.rerankUnits ?? 0, cacheHits: acc.cacheHits ?? 0, estimatedCostMicroUsd: acc.estimatedCostMicroUsd ?? 0,
      } : {}),
      sources: { create: (input.sources ?? []).map((s) => {
        const kind = sourceKind(s.chunkId);
        const d = s.ragDocumentId ? versions.get(s.ragDocumentId) : undefined;
        return { rank: s.rank, cited: s.cited, sourceKind: kind, sourceType: s.sourceType, sourceId: s.sourceId, chunkId: kind === "CHUNK" ? s.chunkId : null, ragDocumentId: s.ragDocumentId, sourceVersion: d?.sourceVersion ?? null, knowledgeVersionId: d?.knowledgeVersionId ?? null, pageNumber: s.pageNumber ?? null, sectionPath: s.sectionPath ?? null, origin: s.origin, recordedAt: s.recordedAt };
      }) },
      id: input.id, organizationId: a.callerOrganizationId ?? null, facilityId: a.callerFacilityId ?? null, userId: input.actor.userId, role: input.actor.kind === "STAFF" ? input.actor.role : "PATIENT",
      patientId: a.subject.patientId, personId: a.subject.personId, shareId: a.shareId ?? null, consentId: a.consentId ?? null,
      mode: input.mode, language: input.language, model: input.model, embeddingModel: input.space.model, embeddingVersion: input.space.version,
      outcome: input.outcome, retrievedChunkIds: input.retrievedChunkIds, citedChunkIds: input.citedChunkIds, topScore: input.topScore, threshold: input.threshold,
      inputTokens: input.inputTokens, outputTokens: input.outputTokens, latencyMs: Date.now() - input.started, metadataExpiresAt: new Date(now.getTime() + METADATA_DAYS * DAY), createdAt: now,
      ...text,
    },
  });
  return input.id;
}

/** A refused request still leaves metadata (no text). */
export async function logRateLimited(actor: AiActor, mode: string): Promise<void> {
  await prisma.aiInteraction.create({ data: { userId: actor.userId, role: actor.kind === "STAFF" ? actor.role : "PATIENT", facilityId: actor.kind === "STAFF" ? actor.facilityId : null, mode, language: "en", model: "none", embeddingModel: "none", embeddingVersion: 0, outcome: "RATE_LIMITED", latencyMs: 0, metadataExpiresAt: new Date(Date.now() + METADATA_DAYS * DAY) } });
}

/**
 * RAG Phase 1 — one portal-assistant request (mode ASSISTANT): metadata only.
 * The assistant is record-free, so there is no patient, no source and no
 * score; its text is never kept, for staff or patients.
 */
export async function logAssistantInteraction(input: { id: string; userId: string; role: string; organizationId: string | null; facilityId: string | null; personId: string | null; language: string; outcome: "ANSWERED" | "REFUSED_SAFETY" | "ERROR"; model: string; inputTokens: number; outputTokens: number; started: number }): Promise<void> {
  const now = new Date();
  await prisma.aiInteraction.create({
    data: {
      id: input.id, userId: input.userId, role: input.role, organizationId: input.organizationId, facilityId: input.facilityId, personId: input.personId,
      mode: "ASSISTANT", language: input.language, model: input.model, embeddingModel: "none", embeddingVersion: 0, outcome: input.outcome,
      module: "CHAT", intent: "GENERAL", tier: input.model === "none" ? 0 : 2, provider: input.model === "none" ? null : input.model,
      retrievedChunkIds: [], citedChunkIds: [], inputTokens: input.inputTokens, outputTokens: input.outputTokens, latencyMs: Date.now() - input.started,
      metadataExpiresAt: new Date(now.getTime() + METADATA_DAYS * DAY), createdAt: now,
    },
  });
}

/** A family member's access was revoked: the text kept of their AI questions about the patient goes (metadata stays). */
export async function purgeProxyAiText(proxyGrantId: string): Promise<number> {
  return (await prisma.aiInteraction.updateMany({
    where: { proxyGrantId, questionCiphertext: { not: null } },
    data: { questionCiphertext: null, answerCiphertext: null, keyVersion: null, textScope: null, textExpiresAt: null },
  })).count;
}

/** The runner's sweep: expired text is cleared; metadata past a year is deleted. */
export async function purgeExpiredAiInteractions(opts: { now?: Date } = {}): Promise<{ textPurged: number; deleted: number }> {
  const now = opts.now ?? new Date();
  const textPurged = (await prisma.aiInteraction.updateMany({ where: { textExpiresAt: { lt: now } }, data: { questionCiphertext: null, answerCiphertext: null, keyVersion: null, textScope: null, textExpiresAt: null } })).count;
  const deleted = (await prisma.aiInteraction.deleteMany({ where: { metadataExpiresAt: { lt: now } } })).count;
  return { textPurged, deleted };
}

const REASONS: AiTextReadReason[] = ["SAFETY_INCIDENT", "QUALITY_REVIEW", "PATIENT_COMPLAINT", "EVALUATION_SAMPLE", "LEGAL_REQUEST"];

/**
 * A reviewer reads retained text: staff text, or patient text kept under an
 * opt-in that included safety review. Anything else is a 404. Logged and
 * audited before the text is returned.
 */
export async function readInteractionText(input: { interactionId: string; reader: { userId: string; role: Role }; reasonCode: string; ticketRef: string }) {
  if (!roleHasPermission(input.reader.role, "ai:interaction:text:read")) throw new NotFoundError();
  if (!(REASONS as string[]).includes(input.reasonCode)) throw new BadRequestError(`reasonCode must be one of ${REASONS.join(", ")}.`);
  if (input.ticketRef.trim().length < 3) throw new BadRequestError("A ticket reference is required.");
  const row = await prisma.aiInteraction.findUnique({ where: { id: input.interactionId } });
  if (!row || !row.questionCiphertext || !row.keyVersion || (row.textScope !== "STAFF_SAFETY" && row.textScope !== "PATIENT_OPT_IN_SAFETY_REVIEW")) throw new NotFoundError();
  await prisma.aiTextReadLog.create({ data: { interactionId: row.id, readerUserId: input.reader.userId, readerRole: input.reader.role, reasonCode: input.reasonCode as AiTextReadReason, ticketRef: input.ticketRef.trim() } });
  await recordAuditEvent("ai.interaction.text_read", input.reader.userId, { interactionId: row.id, reasonCode: input.reasonCode, ticketRef: input.ticketRef.trim() });
  return { interactionId: row.id, mode: row.mode, createdAt: row.createdAt, question: decryptText(row.questionCiphertext, row.keyVersion), answer: row.answerCiphertext ? decryptText(row.answerCiphertext, row.keyVersion) : "" };
}

/** Interaction metadata for reviewers (never text). */
export async function listInteractions(reader: { role: Role }, opts: { since?: Date; outcome?: string; take?: number } = {}) {
  if (!roleHasPermission(reader.role, "ai:interaction:review")) throw new NotFoundError();
  return prisma.aiInteraction.findMany({
    where: { ...(opts.since ? { createdAt: { gte: opts.since } } : {}), ...(opts.outcome ? { outcome: opts.outcome as never } : {}) },
    orderBy: { createdAt: "desc" }, take: Math.min(opts.take ?? 100, 500),
    select: { id: true, createdAt: true, mode: true, role: true, facilityId: true, outcome: true, model: true, topScore: true, threshold: true, latencyMs: true, inputTokens: true, outputTokens: true, textScope: true },
  });
}

/** The monthly review report: every reviewer read of the month, and the month's outcomes by mode. */
export async function monthlyReviewReport(reader: { role: Role }, month: string) {
  if (!roleHasPermission(reader.role, "ai:interaction:review")) throw new NotFoundError();
  if (!/^\d{4}-\d{2}$/.test(month)) throw new BadRequestError("month is YYYY-MM.");
  const from = new Date(`${month}-01T00:00:00Z`);
  const to = new Date(from); to.setUTCMonth(to.getUTCMonth() + 1);
  const [reads, outcomes] = await Promise.all([
    prisma.aiTextReadLog.findMany({ where: { readAt: { gte: from, lt: to } }, orderBy: { readAt: "asc" } }),
    prisma.aiInteraction.groupBy({ by: ["mode", "outcome"], where: { createdAt: { gte: from, lt: to } }, _count: { _all: true } }),
  ]);
  return { month, reads, outcomes: outcomes.map((o) => ({ mode: o.mode, outcome: o.outcome, count: o._count._all })) };
}
