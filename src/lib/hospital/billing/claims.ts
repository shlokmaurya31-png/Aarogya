import { Prisma } from "@prisma/client";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";
import { sumMinor } from "./money";
import { nextSequence, formatSequenceNumber } from "./sequence";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

type Tx = Prisma.TransactionClient;

export class ClaimConcurrencyError extends BadRequestError {
  constructor(action: string) {
    super(`Claim was already ${action} by someone else, or is no longer in the expected state. Refresh and try again.`);
  }
}

const ALLOWED: Record<string, string[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: ["UNDER_REVIEW", "REJECTED"],
  UNDER_REVIEW: ["APPROVED", "PARTIALLY_APPROVED", "REJECTED"],
  APPROVED: ["SETTLED"],
  PARTIALLY_APPROVED: ["SETTLED"],
  REJECTED: ["CLOSED"],
  SETTLED: ["CLOSED"],
  CLOSED: [],
};

/** The claim's invoice context: every claim event is correlated by the encounter. */
async function claimContext(tx: Tx, claimId: string) {
  const claim = await tx.claim.findUniqueOrThrow({ where: { id: claimId }, include: { invoice: { select: { id: true, encounterId: true, patientId: true, currency: true } } } });
  return { claim, base: { claimId: claim.id, encounterId: claim.invoice.encounterId, patientId: claim.invoice.patientId } };
}

/** ClaimStatusChanged (spine §9 step 9): a decision or closure. */
async function emitClaimStatus(tx: Tx, claimId: string, from: string, byUserId: string | null) {
  const { claim, base } = await claimContext(tx, claimId);
  await emitFacilityEvent(tx, {
    type: "ClaimStatusChanged", aggregateId: claim.id, facilityId: claim.facilityId, encounterId: claim.invoice.encounterId, actorUserId: byUserId,
    payload: {
      ...base, invoiceId: claim.invoiceId, from, to: claim.status, currency: claim.invoice.currency,
      ...(claim.approvedAmountMinor !== null ? { approvedAmountMinor: claim.approvedAmountMinor } : {}),
    },
  });
}

/** ClaimSettled (spine §9 step 9; approved change 1): stage SETTLED here, NOTIFIED / RECONCILED from NHCX. */
export async function emitClaimSettled(
  tx: Tx,
  input: { claimId: string; stage: "SETTLED" | "NOTIFIED" | "RECONCILED"; settledAmountMinor: number; settlementId?: string; byUserId: string | null },
) {
  const { claim, base } = await claimContext(tx, input.claimId);
  await emitFacilityEvent(tx, {
    type: "ClaimSettled", aggregateId: claim.id, facilityId: claim.facilityId, encounterId: claim.invoice.encounterId, actorUserId: input.byUserId,
    payload: {
      ...base, invoiceId: claim.invoiceId, stage: input.stage, ...(input.settlementId ? { settlementId: input.settlementId } : {}),
      settledAmountMinor: input.settledAmountMinor, currency: claim.invoice.currency,
    },
  });
}

/** ClaimSubmitted (spine §9 step 9): DIRECT here, NHCX from dispatchSubmission. */
export async function emitClaimSubmitted(
  tx: Tx,
  input: { claimId: string; channel: "DIRECT" | "NHCX"; submissionId?: string; exchangeId?: string; version?: number; byUserId: string | null },
) {
  const { claim, base } = await claimContext(tx, input.claimId);
  await emitFacilityEvent(tx, {
    type: "ClaimSubmitted", aggregateId: claim.id, facilityId: claim.facilityId, encounterId: claim.invoice.encounterId, actorUserId: input.byUserId,
    payload: {
      ...base, channel: input.channel,
      ...(input.submissionId ? { submissionId: input.submissionId } : {}), ...(input.exchangeId ? { exchangeId: input.exchangeId } : {}),
      ...(input.version !== undefined ? { version: input.version } : {}),
    },
  });
}

export function isClaimTransitionAllowed(from: string, to: string): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

/**
 * One claim per invoice this phase (Claim.invoiceId is @unique — split-
 * across-multiple-payers explicitly deferred). ClaimLine rows mirror the
 * invoice's lines 1:1 at draft time, carrying the provenance chain:
 * ClaimLine.invoiceLineId -> InvoiceLine.chargeId -> Charge.sourceType/
 * sourceId -> the originating clinical order.
 */
export async function createClaimDraft(
  tx: Tx,
  input: { invoiceId: string; coverageId: string; facilityId: string; preAuthorizationId?: string; createdByUserId: string }
) {
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: input.invoiceId }, include: { lines: true } });
  if (invoice.status === "DRAFT" || invoice.status === "VOID") {
    throw new BadRequestError("Only an ISSUED (or later) invoice can be claimed.");
  }
  const coverage = await tx.patientCoverage.findUniqueOrThrow({ where: { id: input.coverageId } });
  if (coverage.patientId !== invoice.patientId) throw new BadRequestError("Coverage does not belong to this invoice's patient.");

  const claim = await tx.claim.create({
    data: {
      invoiceId: input.invoiceId,
      coverageId: input.coverageId,
      preAuthorizationId: input.preAuthorizationId,
      facilityId: input.facilityId,
      submittedAmountMinor: sumMinor(invoice.lines.map((l) => l.netAmountMinor)),
      createdByUserId: input.createdByUserId,
    },
  });

  await tx.claimLine.createMany({
    data: invoice.lines.map((line) => ({ claimId: claim.id, invoiceLineId: line.id, claimedAmountMinor: line.netAmountMinor })),
  });
  await emitFacilityEvent(tx, {
    type: "ClaimDrafted", aggregateId: claim.id, facilityId: claim.facilityId, encounterId: invoice.encounterId, actorUserId: input.createdByUserId,
    payload: {
      claimId: claim.id, invoiceId: invoice.id, coverageId: coverage.id, encounterId: invoice.encounterId, patientId: invoice.patientId,
      ...(claim.preAuthorizationId ? { preAuthId: claim.preAuthorizationId } : {}), submittedAmountMinor: claim.submittedAmountMinor, currency: invoice.currency,
    },
  });

  return tx.claim.findUniqueOrThrow({ where: { id: claim.id }, include: { lines: true } });
}

/** Guarded DRAFT -> SUBMITTED: assigns claimNumber atomically via the same fiscal-year sequence mechanism as Invoice numbering (see sequence.ts). */
export async function submitClaim(tx: Tx, claimId: string, input: { byUserId?: string | null } = {}) {
  const claim = await tx.claim.findUniqueOrThrow({ where: { id: claimId } });
  if (!isClaimTransitionAllowed(claim.status, "SUBMITTED")) throw new BadRequestError(`Cannot submit a claim in status ${claim.status}.`);

  const fiscalYear = new Date().getFullYear();
  const seq = await nextSequence(tx, { facilityId: claim.facilityId, fiscalYear });
  const claimNumber = formatSequenceNumber("CLM", fiscalYear, seq);

  const result = await tx.claim.updateMany({
    where: { id: claimId, status: "DRAFT" },
    data: { status: "SUBMITTED", claimNumber, submittedAt: new Date() },
  });
  if (result.count !== 1) throw new ClaimConcurrencyError("submitted");
  await emitClaimSubmitted(tx, { claimId, channel: "DIRECT", byUserId: input.byUserId ?? null });
  return tx.claim.findUniqueOrThrow({ where: { id: claimId } });
}

/** Manual entry of the payer's decision (no live payer API this phase) — see docs/PHASE_5_SCOPE_AND_DEFERRALS.md. */
export async function recordClaimDecision(
  tx: Tx,
  claimId: string,
  input: { status: "UNDER_REVIEW" | "APPROVED" | "PARTIALLY_APPROVED" | "REJECTED"; approvedAmountMinor?: number; denialReason?: string; byUserId?: string | null }
) {
  const claim = await tx.claim.findUniqueOrThrow({ where: { id: claimId } });
  if (!isClaimTransitionAllowed(claim.status, input.status)) throw new BadRequestError(`Cannot move a claim from ${claim.status} to ${input.status}.`);
  if ((input.status === "APPROVED" || input.status === "PARTIALLY_APPROVED") && typeof input.approvedAmountMinor !== "number") {
    throw new BadRequestError("approvedAmountMinor is required for an approval decision.");
  }
  if (input.status === "REJECTED" && !input.denialReason) throw new BadRequestError("denialReason is required for a rejection.");

  const result = await tx.claim.updateMany({
    where: { id: claimId, status: claim.status },
    data: { status: input.status, approvedAmountMinor: input.approvedAmountMinor, denialReason: input.denialReason, decidedAt: new Date() },
  });
  if (result.count !== 1) throw new ClaimConcurrencyError("updated");
  await emitClaimStatus(tx, claimId, claim.status, input.byUserId ?? null);
  return tx.claim.findUniqueOrThrow({ where: { id: claimId } });
}

/** Records that the payer's approved amount has been finalized. The actual money arriving is a separate step — record it via the normal payments API with method=INSURANCE_SETTLEMENT, then allocate it to the invoice, exactly like any other payment. */
export async function settleClaim(tx: Tx, claimId: string, input: { settledAmountMinor: number; byUserId?: string | null }) {
  const claim = await tx.claim.findUniqueOrThrow({ where: { id: claimId } });
  if (!isClaimTransitionAllowed(claim.status, "SETTLED")) throw new BadRequestError(`Cannot settle a claim in status ${claim.status}.`);

  const result = await tx.claim.updateMany({
    where: { id: claimId, status: claim.status },
    data: { status: "SETTLED", settledAmountMinor: input.settledAmountMinor, settledAt: new Date() },
  });
  if (result.count !== 1) throw new ClaimConcurrencyError("settled");
  await emitClaimSettled(tx, { claimId, stage: "SETTLED", settledAmountMinor: input.settledAmountMinor, byUserId: input.byUserId ?? null });
  return tx.claim.findUniqueOrThrow({ where: { id: claimId } });
}

export async function closeClaim(tx: Tx, claimId: string, input: { byUserId?: string | null } = {}) {
  const claim = await tx.claim.findUniqueOrThrow({ where: { id: claimId } });
  if (!isClaimTransitionAllowed(claim.status, "CLOSED")) throw new BadRequestError(`Cannot close a claim in status ${claim.status}.`);
  const result = await tx.claim.updateMany({ where: { id: claimId, status: claim.status }, data: { status: "CLOSED" } });
  if (result.count !== 1) throw new ClaimConcurrencyError("closed");
  await emitClaimStatus(tx, claimId, claim.status, input.byUserId ?? null);
  return tx.claim.findUniqueOrThrow({ where: { id: claimId } });
}

export async function findClaimInFacility(claimId: string, facilityId: string) {
  const claim = await prisma.claim.findUnique({ where: { id: claimId }, include: { lines: true, coverage: true } });
  if (!claim || claim.facilityId !== facilityId) throw new NotFoundError("Claim not found.");
  return claim;
}
