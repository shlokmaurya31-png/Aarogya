import { Prisma } from "@prisma/client";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";
import { sumMinor } from "./money";
import { nextSequence, formatSequenceNumber } from "./sequence";

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

  return tx.claim.findUniqueOrThrow({ where: { id: claim.id }, include: { lines: true } });
}

/** Guarded DRAFT -> SUBMITTED: assigns claimNumber atomically via the same fiscal-year sequence mechanism as Invoice numbering (see sequence.ts). */
export async function submitClaim(tx: Tx, claimId: string) {
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
  return tx.claim.findUniqueOrThrow({ where: { id: claimId } });
}

/** Manual entry of the payer's decision (no live payer API this phase) — see docs/PHASE_5_SCOPE_AND_DEFERRALS.md. */
export async function recordClaimDecision(
  tx: Tx,
  claimId: string,
  input: { status: "UNDER_REVIEW" | "APPROVED" | "PARTIALLY_APPROVED" | "REJECTED"; approvedAmountMinor?: number; denialReason?: string }
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
  return tx.claim.findUniqueOrThrow({ where: { id: claimId } });
}

/** Records that the payer's approved amount has been finalized. The actual money arriving is a separate step — record it via the normal payments API with method=INSURANCE_SETTLEMENT, then allocate it to the invoice, exactly like any other payment. */
export async function settleClaim(tx: Tx, claimId: string, input: { settledAmountMinor: number }) {
  const claim = await tx.claim.findUniqueOrThrow({ where: { id: claimId } });
  if (!isClaimTransitionAllowed(claim.status, "SETTLED")) throw new BadRequestError(`Cannot settle a claim in status ${claim.status}.`);

  const result = await tx.claim.updateMany({
    where: { id: claimId, status: claim.status },
    data: { status: "SETTLED", settledAmountMinor: input.settledAmountMinor, settledAt: new Date() },
  });
  if (result.count !== 1) throw new ClaimConcurrencyError("settled");
  return tx.claim.findUniqueOrThrow({ where: { id: claimId } });
}

export async function closeClaim(tx: Tx, claimId: string) {
  const claim = await tx.claim.findUniqueOrThrow({ where: { id: claimId } });
  if (!isClaimTransitionAllowed(claim.status, "CLOSED")) throw new BadRequestError(`Cannot close a claim in status ${claim.status}.`);
  const result = await tx.claim.updateMany({ where: { id: claimId, status: claim.status }, data: { status: "CLOSED" } });
  if (result.count !== 1) throw new ClaimConcurrencyError("closed");
  return tx.claim.findUniqueOrThrow({ where: { id: claimId } });
}

export async function findClaimInFacility(claimId: string, facilityId: string) {
  const claim = await prisma.claim.findUnique({ where: { id: claimId }, include: { lines: true, coverage: true } });
  if (!claim || claim.facilityId !== facilityId) throw new NotFoundError("Claim not found.");
  return claim;
}
