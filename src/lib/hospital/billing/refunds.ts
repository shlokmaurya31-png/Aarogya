import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";

type Tx = Prisma.TransactionClient;

export class RefundConcurrencyError extends BadRequestError {
  constructor(action: string) {
    super(`Refund was already ${action} by someone else, or is no longer in the expected state. Refresh and try again.`);
  }
}

export class OverRefundError extends BadRequestError {
  constructor() {
    super("Requested refund amount exceeds this payment's refundable balance.");
  }
}

export class SameApproverError extends BadRequestError {
  constructor() {
    super("A refund cannot be approved by the same user who requested it (maker-checker).");
  }
}

const ALLOWED: Record<string, string[]> = {
  REQUESTED: ["APPROVED", "REJECTED"],
  APPROVED: ["COMPLETED"],
  REJECTED: [],
  COMPLETED: [],
};

export function isRefundTransitionAllowed(from: string, to: string): boolean {
  return (ALLOWED[from] ?? []).includes(to);
}

/**
 * Foundation-phase scope: a refund targets only the UNALLOCATED portion of
 * a payment (amountMinor - allocatedMinor - refundedMinor) — refunding
 * money already applied to a paid invoice requires first freeing that
 * allocation via a FinancialAdjustment on the invoice (not built this
 * phase; documented in docs/PHASE_5_SCOPE_AND_DEFERRALS.md). Idempotent on
 * idempotencyKey, same pattern as recordPayment.
 */
export async function requestRefund(
  tx: Tx,
  input: { paymentId: string; amountMinor: number; reason: string; requestedByUserId: string; idempotencyKey: string }
) {
  const existing = await tx.refund.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return { refund: existing, alreadyExisted: true as const };

  if (input.amountMinor <= 0) throw new BadRequestError("amountMinor must be positive.");

  const payment = await tx.payment.findUniqueOrThrow({ where: { id: input.paymentId } });
  const refundable = payment.amountMinor - payment.allocatedMinor - payment.refundedMinor;
  if (input.amountMinor > refundable) throw new OverRefundError();

  // Raw INSERT ... ON CONFLICT DO NOTHING — see chargeCapture.ts's
  // createChargeIfNotExists for the full explanation.
  const rowsInserted = await tx.$executeRaw`
    INSERT INTO "Refund" (id, "paymentId", "amountMinor", reason, "requestedByUserId", "idempotencyKey")
    VALUES (${randomUUID()}, ${input.paymentId}, ${input.amountMinor}, ${input.reason}, ${input.requestedByUserId}, ${input.idempotencyKey})
    ON CONFLICT ("idempotencyKey") DO NOTHING
  `;
  const refund = await tx.refund.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });

  return { refund, alreadyExisted: rowsInserted === 0 };
}

export async function approveRefund(tx: Tx, refundId: string, input: { approvedByUserId: string }) {
  const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
  if (refund.requestedByUserId === input.approvedByUserId) throw new SameApproverError();

  const result = await tx.refund.updateMany({
    where: { id: refundId, status: "REQUESTED" },
    data: { status: "APPROVED", approvedByUserId: input.approvedByUserId },
  });
  if (result.count !== 1) throw new RefundConcurrencyError("approved");
  return tx.refund.findUniqueOrThrow({ where: { id: refundId } });
}

export async function rejectRefund(tx: Tx, refundId: string) {
  const result = await tx.refund.updateMany({ where: { id: refundId, status: "REQUESTED" }, data: { status: "REJECTED" } });
  if (result.count !== 1) throw new RefundConcurrencyError("rejected");
  return tx.refund.findUniqueOrThrow({ where: { id: refundId } });
}

/**
 * CAS-updates Payment.refundedMinor in the same transaction as the status
 * flip — bounded retry loop, same idiom as allocatePayment. Never exceeds
 * amountMinor - allocatedMinor even under genuine concurrent completion
 * attempts on two different refunds against the same payment.
 */
export async function completeRefund(tx: Tx, refundId: string) {
  const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
  if (refund.status !== "APPROVED") throw new BadRequestError(`Cannot complete a refund in status ${refund.status}.`);

  for (let attempt = 0; attempt < 5; attempt++) {
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: refund.paymentId } });
    const refundable = payment.amountMinor - payment.allocatedMinor - payment.refundedMinor;
    if (refund.amountMinor > refundable) throw new OverRefundError();

    const paymentUpdate = await tx.payment.updateMany({
      where: { id: refund.paymentId, refundedMinor: payment.refundedMinor },
      data: { refundedMinor: payment.refundedMinor + refund.amountMinor },
    });
    if (paymentUpdate.count === 1) {
      const refundUpdate = await tx.refund.updateMany({ where: { id: refundId, status: "APPROVED" }, data: { status: "COMPLETED", completedAt: new Date() } });
      if (refundUpdate.count !== 1) throw new RefundConcurrencyError("completed");
      return tx.refund.findUniqueOrThrow({ where: { id: refundId } });
    }
  }
  throw new RefundConcurrencyError("completed");
}

export async function findRefundInFacility(refundId: string, facilityId: string) {
  const refund = await prisma.refund.findUnique({ where: { id: refundId }, include: { payment: true } });
  if (!refund || refund.payment.facilityId !== facilityId) throw new NotFoundError("Refund not found.");
  return refund;
}
