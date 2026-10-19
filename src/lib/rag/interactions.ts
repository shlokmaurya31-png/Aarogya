import type { AiTextReadReason, AiTextScope } from "@prisma/client";
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

export interface LogInput {
  id: string; actor: AiActor; access: AiAccess; mode: AiMode; language: string; question: string | null; answerText: string;
  space: { model: string; version: number }; started: number;
  outcome: "ANSWERED" | "NO_RECORD" | "REFUSED_SAFETY" | "CITATION_INVALID" | "RATE_LIMITED" | "ERROR";
  retrievedChunkIds: string[]; citedChunkIds: string[]; topScore: number | null; threshold: number | null; model: string; inputTokens: number; outputTokens: number;
}

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
  await prisma.aiInteraction.create({
    data: {
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
