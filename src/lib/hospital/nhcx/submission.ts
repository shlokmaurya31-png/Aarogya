import { createHash, randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { requireAuthorization } from "@/lib/auth/authorize/engine";
import type { AuthorizationActor } from "@/lib/auth/authorize/types";
import { buildClaimPackage, hashPackage } from "./claimPackage";
import { buildClaimBundle } from "./fhirMapper";
import { getNhcxAdapter, toNhcxError, type NhcxAdapter } from "./adapter";
import { NHCX_PARTICIPANT_SYSTEM } from "./contract";
import {
  SUBMISSION_TRANSITIONS, PROTOCOL_TRANSITIONS, isTransitionAllowed,
  canonicalStatusForSubmission, type SubmissionStatus, type ProtocolState,
} from "./stateMachines";
import { nextRetryDelayMs, type NhcxErrorCategory } from "./errors";

/**
 * Phase C5 — claim submission lifecycle.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE SHAPE THAT MATTERS
 *
 *   local transaction → build + persist an immutable submission → COMMIT
 *   (no transaction)  → adapter call → record the outcome
 *
 * The external call is never inside a financial transaction. An unreachable
 * claims network cannot roll back, block or corrupt billing that has already
 * happened — the same isolation C1 established for ABDM.
 *
 * Claim.invoiceId is @unique, so a resubmission cannot be a second Claim row.
 * Versioned ClaimSubmission records are how history survives: the original is
 * marked SUPERSEDED, never rewritten and never deleted.
 * ════════════════════════════════════════════════════════════════════════════
 */

export class SubmissionConcurrencyError extends ConflictError {
  constructor(message = "This submission changed concurrently. Refresh and try again.") {
    super(message);
  }
}

/**
 * Deterministic idempotency key.
 *
 * Derived from the claim, version and package hash — so retrying the SAME
 * submission collapses onto the same exchange, while a genuinely different
 * package (corrected lines, new documents) produces a new key and is allowed
 * through. Namespaced by facility so one facility can never collide with, or
 * address, another's exchange.
 */
export function buildIdempotencyKey(parts: {
  facilityId: string; claimId: string; version: number; packageHash: string;
}): string {
  return createHash("sha256")
    .update(`${parts.facilityId}|${parts.claimId}|v${parts.version}|${parts.packageHash}`)
    .digest("hex");
}

/** Resolve the payer's NHCX participant code, if one has been mapped. */
async function resolveParticipantCode(facilityId: string, payerId: string): Promise<string | null> {
  const row = await prisma.externalIdentifier.findFirst({
    where: {
      facilityId, entityType: "PAYER", entityId: payerId,
      system: NHCX_PARTICIPANT_SYSTEM, status: "ACTIVE",
    },
    select: { value: true },
  });
  return row?.value ?? null;
}

export interface BuildSubmissionInput {
  claimId: string;
  facilityId: string;
  actor: AuthorizationActor;
  submissionType?: "ORIGINAL" | "RESUBMISSION" | "APPEAL";
  correctionReason?: string;
  /** Injected in tests so the bundle is reproducible. */
  timestamp?: Date;
}

/**
 * Compose and persist an immutable submission.
 *
 * Authorization runs FIRST, through the C4 engine, before any clinical or
 * financial record is read. Purpose is INSURANCE — deliberately not TREATMENT,
 * because a disclosure to a payer is not treatment and must not inherit a
 * treatment consent.
 */
export async function buildSubmission(input: BuildSubmissionInput) {
  const timestamp = input.timestamp ?? new Date();

  const claim = await prisma.claim.findUnique({
    where: { id: input.claimId },
    include: { invoice: { select: { patientId: true, encounterId: true, id: true } } },
  });
  if (!claim || claim.facilityId !== input.facilityId) throw new NotFoundError("Claim not found.");

  await requireAuthorization({
    actor: input.actor,
    action: "claim.submit",
    resource: {
      type: "CLAIM", id: claim.id, facilityId: input.facilityId,
      patientId: claim.invoice.patientId, dataClass: "FINANCIAL",
    },
    purpose: "INSURANCE",
    scopes: ["BILLING"],
  });

  const pkg = await buildClaimPackage({
    claimId: input.claimId, facilityId: input.facilityId, actor: input.actor,
  });

  if (pkg.blockers.length > 0) {
    // Never a silent partial submission: a blocked package is refused with the
    // full list so the pre-flight checklist can show every problem at once.
    throw new BadRequestError(`Claim cannot be submitted: ${pkg.blockers.join(" ")}`);
  }

  const priorCount = await prisma.claimSubmission.count({ where: { claimId: claim.id } });
  const version = priorCount + 1;
  const submissionType = input.submissionType ?? (version === 1 ? "ORIGINAL" : "RESUBMISSION");

  if (version > 1 && !input.correctionReason?.trim()) {
    throw new BadRequestError("A correction reason is required when resubmitting a claim.");
  }

  const participantCode = await resolveParticipantCode(input.facilityId, pkg.coverage.payerId);
  const facility = await prisma.facility.findUniqueOrThrow({ where: { id: input.facilityId } });
  const patientExternalIds = await prisma.externalIdentifier.findMany({
    where: { facilityId: input.facilityId, entityType: "PATIENT", entityId: pkg.patient.id, status: "ACTIVE" },
    select: { system: true, value: true, use: true, status: true },
  });

  const bundleId = `${claim.id}-v${version}`;
  const bundle = buildClaimBundle(pkg, {
    timestamp, bundleId,
    facilityName: facility.name,
    payerParticipantCode: participantCode,
    patientExternalIdentifiers: patientExternalIds,
  });

  const snapshot = { package: pkg, bundle };
  const { hash, bytes } = hashPackage(snapshot);

  const submission = await prisma.$transaction(async (tx) => {
    // Supersede any earlier live submission. The row is never deleted — the
    // rejection or the original claim content must remain reconstructable.
    await tx.claimSubmission.updateMany({
      where: { claimId: claim.id, status: { in: ["DRAFT", "READY", "REJECTED", "FAILED"] } },
      data: { status: "SUPERSEDED" },
    });

    return tx.claimSubmission.create({
      data: {
        facilityId: input.facilityId,
        claimId: claim.id,
        version,
        submissionType,
        status: "READY",
        // Server-derived from canonical lines, never from a request body.
        claimedAmountMinor: pkg.totals.claimedMinor,
        correctionReason: input.correctionReason?.trim() || null,
        patientId: pkg.patient.id,
        encounterId: pkg.encounter?.id ?? null,
        coverageId: pkg.coverage.id,
        payerId: pkg.coverage.payerId,
        invoiceId: pkg.invoice.id,
        snapshot: snapshot as never,
        snapshotHash: hash,
        snapshotBytes: bytes,
        builtByUserId: input.actor.userId,
      },
    });
  });

  await recordAuditEvent(
    "hospital.claim.submissionBuilt",
    input.actor.userId,
    {
      claimId: claim.id, submissionId: submission.id, version, submissionType,
      claimedAmountMinor: pkg.totals.claimedMinor, documentCount: pkg.documents.length,
      excludedDocuments: pkg.excludedDocuments.length, snapshotHash: hash,
    },
    { facilityId: input.facilityId, patientId: pkg.patient.id }
  );

  return { submission, package: pkg, warnings: pkg.warnings, excludedDocuments: pkg.excludedDocuments };
}

/** Guarded submission-status transition. */
async function transitionSubmission(
  submissionId: string, facilityId: string, to: SubmissionStatus,
  data: Record<string, unknown>, byUserId: string
) {
  return prisma.$transaction(async (tx) => {
    const s = await tx.claimSubmission.findUnique({ where: { id: submissionId } });
    if (!s || s.facilityId !== facilityId) throw new NotFoundError("Submission not found.");
    if (!isTransitionAllowed(SUBMISSION_TRANSITIONS, s.status, to)) {
      throw new BadRequestError(`Illegal submission transition ${s.status} -> ${to}.`);
    }
    const r = await tx.claimSubmission.updateMany({
      where: { id: s.id, status: s.status, lockVersion: s.lockVersion },
      data: { ...data, status: to, lockVersion: { increment: 1 } },
    });
    if (r.count !== 1) throw new SubmissionConcurrencyError();
    void byUserId;
    return tx.claimSubmission.findUniqueOrThrow({ where: { id: s.id } });
  });
}

/**
 * Dispatch a submission to the external network.
 *
 * Creates the exchange record and commits it BEFORE calling the adapter, so a
 * transport failure leaves a durable, inspectable attempt rather than nothing.
 * The idempotency key is a unique column, which is what actually prevents a
 * duplicate external submission under a genuine race — not a check-then-insert.
 */
export async function dispatchSubmission(
  input: { submissionId: string; facilityId: string; actor: AuthorizationActor },
  options: { adapter?: NhcxAdapter } = {}
) {
  const submission = await prisma.claimSubmission.findUnique({ where: { id: input.submissionId } });
  if (!submission || submission.facilityId !== input.facilityId) throw new NotFoundError("Submission not found.");

  // Re-authorize at dispatch: the decision at build time may no longer hold.
  await requireAuthorization({
    actor: input.actor,
    action: "claim.dispatch",
    resource: {
      type: "CLAIM", id: submission.claimId, facilityId: input.facilityId,
      patientId: submission.patientId, dataClass: "FINANCIAL",
    },
    purpose: "INSURANCE",
    scopes: ["BILLING"],
  });

  const idempotencyKey = buildIdempotencyKey({
    facilityId: input.facilityId, claimId: submission.claimId,
    version: submission.version, packageHash: submission.snapshotHash ?? "",
  });

  // Idempotency: an identical dispatch resolves to the EXISTING exchange.
  const existing = await prisma.nhcxExchange.findUnique({ where: { idempotencyKey } });
  if (existing) {
    if (existing.facilityId !== input.facilityId) {
      throw new ConflictError("That submission is already in progress.");
    }
    return { exchange: existing, deduplicated: true, result: null };
  }

  const correlationId = randomUUID();
  let exchange;
  try {
    exchange = await prisma.nhcxExchange.create({
      data: {
        facilityId: input.facilityId,
        submissionId: submission.id,
        claimId: submission.claimId,
        exchangeType: "CLAIM",
        direction: "OUTBOUND",
        protocolState: "NOT_SUBMITTED",
        idempotencyKey,
        correlationId,
        requestedByUserId: input.actor.userId,
      },
    });
  } catch (e) {
    // Lost the insert race: somebody else created the same logical exchange.
    if ((e as { code?: string })?.code === "P2002") {
      const raced = await prisma.nhcxExchange.findUnique({ where: { idempotencyKey } });
      if (raced && raced.facilityId === input.facilityId) {
        return { exchange: raced, deduplicated: true, result: null };
      }
      throw new ConflictError("That submission is already in progress.");
    }
    throw e;
  }

  await transitionSubmission(submission.id, input.facilityId, "SUBMITTED",
    { submittedAt: new Date(), submittedByUserId: input.actor.userId }, input.actor.userId);
  await syncCanonicalClaimStatus(submission.claimId, input.facilityId, "SUBMITTED", input.actor.userId);

  await recordAuditEvent(
    "hospital.claim.submitted",
    input.actor.userId,
    { claimId: submission.claimId, submissionId: submission.id, exchangeId: exchange.id, correlationId },
    { facilityId: input.facilityId, patientId: submission.patientId }
  );

  // ── External call, OUTSIDE any transaction ──────────────────────────────
  const adapter = options.adapter ?? getNhcxAdapter();
  const startedAt = Date.now();
  const snapshot = submission.snapshot as { bundle?: unknown } | null;
  const result = await adapter.submit({
    facilityId: input.facilityId,
    correlationId,
    idempotencyKey,
    exchangeType: "CLAIM",
    bundle: snapshot?.bundle ?? null,
  });
  const latencyMs = Date.now() - startedAt;

  if (result.outcome === "OK") {
    const updated = await transitionExchange(exchange.id, input.facilityId, "SUBMITTED", {
      submittedAt: new Date(), latencyMs,
      externalReference: result.externalReference ?? result.data?.externalReference ?? null,
      attemptCount: { increment: 1 },
    });
    await recordAuditEvent(
      "hospital.claim.exchangeAccepted",
      input.actor.userId,
      { exchangeId: exchange.id, correlationId, externalReference: updated.externalReference },
      { facilityId: input.facilityId, patientId: submission.patientId }
    );
    return { exchange: updated, deduplicated: false, result };
  }

  const error = toNhcxError(result, correlationId);
  const delay = nextRetryDelayMs(exchange.attemptCount, error.category as NhcxErrorCategory);
  const failed = await transitionExchange(exchange.id, input.facilityId, "FAILED", {
    errorCategory: error.category,
    errorMessage: error.message,
    attemptCount: { increment: 1 },
    latencyMs,
    nextRetryAt: delay !== null && exchange.attemptCount + 1 < exchange.maxAttempts
      ? new Date(Date.now() + delay) : null,
  });
  // The submission goes back to FAILED, NOT REJECTED: a transport failure is
  // not a payer decision, and conflating them would misreport the claim.
  await transitionSubmission(submission.id, input.facilityId, "FAILED", {}, input.actor.userId);

  await recordAuditEvent(
    "hospital.claim.exchangeFailed",
    input.actor.userId,
    { exchangeId: exchange.id, correlationId, category: error.category, retryable: error.retryable },
    { facilityId: input.facilityId, patientId: submission.patientId }
  );
  return { exchange: failed, deduplicated: false, result };
}

/** Guarded protocol-state transition on an exchange. */
export async function transitionExchange(
  exchangeId: string, facilityId: string, to: ProtocolState, data: Record<string, unknown> = {}
) {
  return prisma.$transaction(async (tx) => {
    const ex = await tx.nhcxExchange.findUnique({ where: { id: exchangeId } });
    if (!ex || ex.facilityId !== facilityId) throw new NotFoundError("Exchange not found.");
    if (!isTransitionAllowed(PROTOCOL_TRANSITIONS, ex.protocolState, to)) {
      throw new BadRequestError(`Illegal protocol transition ${ex.protocolState} -> ${to}.`);
    }
    const r = await tx.nhcxExchange.updateMany({
      where: { id: ex.id, protocolState: ex.protocolState, version: ex.version },
      data: { ...data, protocolState: to, version: { increment: 1 } },
    });
    if (r.count !== 1) throw new SubmissionConcurrencyError("That exchange changed concurrently.");
    return tx.nhcxExchange.findUniqueOrThrow({ where: { id: ex.id } });
  });
}

/**
 * Reflect a submission outcome onto the canonical claim, using the EXISTING
 * Phase 5 transition rules. Never forces an illegal canonical transition — if
 * billing does not permit the move, the protocol record simply keeps the truth
 * and the claim is left alone.
 */
export async function syncCanonicalClaimStatus(
  claimId: string, facilityId: string, submissionStatus: SubmissionStatus, byUserId: string
) {
  const target = canonicalStatusForSubmission(submissionStatus);
  if (!target) return null;

  const { isClaimTransitionAllowed } = await import("@/lib/hospital/billing/claims");
  const claim = await prisma.claim.findUnique({ where: { id: claimId } });
  if (!claim || claim.facilityId !== facilityId) return null;
  if (claim.status === target) return claim;
  if (!isClaimTransitionAllowed(claim.status, target)) return claim;

  const r = await prisma.claim.updateMany({
    where: { id: claim.id, status: claim.status },
    data: { status: target as never, ...(target === "SUBMITTED" ? { submittedAt: new Date() } : {}) },
  });
  if (r.count !== 1) return claim;

  await recordAuditEvent(
    "hospital.claim.statusSynced",
    byUserId,
    { claimId, from: claim.status, to: target, source: "submission" },
    { facilityId }
  );
  return prisma.claim.findUnique({ where: { id: claim.id } });
}

/**
 * Manually retry a failed exchange.
 *
 * Reuses the SAME idempotency identity, so a retry can never create a second
 * logical external submission. Refuses once the attempt budget is spent.
 */
export async function retryExchange(
  input: { exchangeId: string; facilityId: string; actor: AuthorizationActor },
  options: { adapter?: NhcxAdapter } = {}
) {
  const ex = await prisma.nhcxExchange.findUnique({ where: { id: input.exchangeId } });
  if (!ex || ex.facilityId !== input.facilityId) throw new NotFoundError("Exchange not found.");
  if (ex.protocolState !== "FAILED") throw new BadRequestError("Only a failed exchange can be retried.");
  if (ex.attemptCount >= ex.maxAttempts) {
    throw new BadRequestError(`This exchange has exhausted its ${ex.maxAttempts} attempts.`);
  }
  if (!ex.errorCategory) throw new BadRequestError("This exchange has no recorded failure to retry.");

  const { isRetryableCategory } = await import("./errors");
  if (!isRetryableCategory(ex.errorCategory as NhcxErrorCategory)) {
    // A validation or authorization failure cannot succeed on retry, and for a
    // partially-applied submission it could duplicate a claim at the payer.
    throw new BadRequestError(
      `A ${ex.errorCategory} failure is not retryable. Correct the claim and resubmit as a new version.`
    );
  }
  if (!ex.submissionId) throw new BadRequestError("This exchange has no submission to retry.");

  // The submission is read BEFORE authorization because the patient is part of
  // the authorization request: without it the engine cannot evaluate consent,
  // and a retry would be denied for the wrong reason.
  const submission = await prisma.claimSubmission.findUniqueOrThrow({ where: { id: ex.submissionId } });
  if (submission.facilityId !== input.facilityId) throw new NotFoundError("Exchange not found.");

  await requireAuthorization({
    actor: input.actor,
    action: "claim.dispatch",
    resource: {
      type: "CLAIM", id: ex.claimId ?? undefined, facilityId: input.facilityId,
      patientId: submission.patientId, dataClass: "FINANCIAL",
    },
    purpose: "INSURANCE",
    scopes: ["BILLING"],
  });

  const adapter = options.adapter ?? getNhcxAdapter();
  const startedAt = Date.now();
  const snapshot = submission.snapshot as { bundle?: unknown } | null;

  const result = await adapter.submit({
    facilityId: input.facilityId,
    correlationId: ex.correlationId,
    idempotencyKey: ex.idempotencyKey, // unchanged, on purpose
    exchangeType: ex.exchangeType,
    bundle: snapshot?.bundle ?? null,
  });
  const latencyMs = Date.now() - startedAt;

  if (result.outcome === "OK") {
    const updated = await transitionExchange(ex.id, input.facilityId, "SUBMITTED", {
      submittedAt: new Date(), latencyMs, attemptCount: { increment: 1 }, nextRetryAt: null,
      externalReference: result.externalReference ?? null, errorCategory: null, errorMessage: null,
    });
    await recordAuditEvent(
      "hospital.claim.exchangeRetried",
      input.actor.userId,
      { exchangeId: ex.id, correlationId: ex.correlationId, outcome: "OK" },
      { facilityId: input.facilityId }
    );
    return updated;
  }

  const error = toNhcxError(result, ex.correlationId);
  const attempt = ex.attemptCount + 1;
  const delay = nextRetryDelayMs(attempt, error.category as NhcxErrorCategory);
  const failed = await prisma.nhcxExchange.update({
    where: { id: ex.id },
    data: {
      attemptCount: attempt, latencyMs,
      errorCategory: error.category, errorMessage: error.message,
      nextRetryAt: delay !== null && attempt < ex.maxAttempts ? new Date(Date.now() + delay) : null,
      version: { increment: 1 },
    },
  });
  await recordAuditEvent(
    "hospital.claim.exchangeRetried",
    input.actor.userId,
    { exchangeId: ex.id, correlationId: ex.correlationId, outcome: error.category },
    { facilityId: input.facilityId }
  );
  return failed;
}
