import { Prisma, AdjustmentType } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";

type Tx = Prisma.TransactionClient;

export class AdjustmentConcurrencyError extends BadRequestError {
  constructor(action: string) {
    super(`Adjustment was already ${action} by someone else, or is no longer in the expected state. Refresh and try again.`);
  }
}

export class SameApproverError extends BadRequestError {
  constructor() {
    super("An adjustment cannot be approved by the same user who requested it (maker-checker).");
  }
}

/**
 * Corrects an issued invoice without mutating it. Only legal against
 * ISSUED/PARTIALLY_PAID/PAID invoices (a DRAFT invoice is already mutable,
 * a VOID one needs no adjustment). Once APPROVED, immutable — a further
 * correction is a NEW, opposite-direction adjustment, never an edit.
 */
export async function createAdjustment(
  tx: Tx,
  input: { invoiceId: string; type: AdjustmentType; amountMinor: number; reason: string; requestedByUserId: string }
) {
  if (input.amountMinor <= 0) throw new BadRequestError("amountMinor must be positive.");
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: input.invoiceId } });
  if (!["ISSUED", "PARTIALLY_PAID", "PAID"].includes(invoice.status)) {
    throw new BadRequestError(`Cannot adjust an invoice in status ${invoice.status}.`);
  }

  return tx.financialAdjustment.create({
    data: { invoiceId: input.invoiceId, type: input.type, amountMinor: input.amountMinor, reason: input.reason, requestedByUserId: input.requestedByUserId },
  });
}

export async function approveAdjustment(tx: Tx, adjustmentId: string, input: { approvedByUserId: string }) {
  const adjustment = await tx.financialAdjustment.findUniqueOrThrow({ where: { id: adjustmentId } });
  if (adjustment.requestedByUserId === input.approvedByUserId) throw new SameApproverError();

  const result = await tx.financialAdjustment.updateMany({
    where: { id: adjustmentId, status: "PENDING" },
    data: { status: "APPROVED", approvedByUserId: input.approvedByUserId },
  });
  if (result.count !== 1) throw new AdjustmentConcurrencyError("approved");
  return tx.financialAdjustment.findUniqueOrThrow({ where: { id: adjustmentId } });
}

export async function rejectAdjustment(tx: Tx, adjustmentId: string) {
  const result = await tx.financialAdjustment.updateMany({ where: { id: adjustmentId, status: "PENDING" }, data: { status: "REJECTED" } });
  if (result.count !== 1) throw new AdjustmentConcurrencyError("rejected");
  return tx.financialAdjustment.findUniqueOrThrow({ where: { id: adjustmentId } });
}
