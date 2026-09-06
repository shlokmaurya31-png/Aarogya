import { Prisma } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";

type Tx = Prisma.TransactionClient;

export class PreAuthConcurrencyError extends BadRequestError {
  constructor(action: string) {
    super(`Pre-authorization was already ${action} by someone else, or is no longer in the expected state. Refresh and try again.`);
  }
}

/** Foundation only — manual entry, no live payer API (see PreAuthorization's schema doc comment). */
export async function requestPreAuth(
  tx: Tx,
  input: { coverageId: string; encounterId: string; requestedAmountMinor: number; requestedByUserId: string; payerReferenceNo?: string; notes?: string }
) {
  if (input.requestedAmountMinor <= 0) throw new BadRequestError("requestedAmountMinor must be positive.");
  return tx.preAuthorization.create({
    data: {
      coverageId: input.coverageId,
      encounterId: input.encounterId,
      requestedAmountMinor: input.requestedAmountMinor,
      requestedByUserId: input.requestedByUserId,
      payerReferenceNo: input.payerReferenceNo,
      notes: input.notes,
    },
  });
}

export async function decidePreAuth(tx: Tx, preAuthId: string, input: { status: "APPROVED" | "DENIED"; approvedAmountMinor?: number }) {
  if (input.status === "APPROVED" && typeof input.approvedAmountMinor !== "number") {
    throw new BadRequestError("approvedAmountMinor is required for an approval.");
  }
  const result = await tx.preAuthorization.updateMany({
    where: { id: preAuthId, status: "REQUESTED" },
    data: { status: input.status, approvedAmountMinor: input.approvedAmountMinor, decidedAt: new Date() },
  });
  if (result.count !== 1) throw new PreAuthConcurrencyError("decided");
  return tx.preAuthorization.findUniqueOrThrow({ where: { id: preAuthId } });
}

/** Staff-triggered only — this codebase has no cron/background job anywhere, so EXPIRED is never set automatically. See isPreAuthStale for the live-computed staleness warning used by financialClearance.ts instead. */
export async function expirePreAuth(tx: Tx, preAuthId: string) {
  const result = await tx.preAuthorization.updateMany({
    where: { id: preAuthId, status: { in: ["REQUESTED", "APPROVED"] } },
    data: { status: "EXPIRED", decidedAt: new Date() },
  });
  if (result.count !== 1) throw new PreAuthConcurrencyError("expired");
  return tx.preAuthorization.findUniqueOrThrow({ where: { id: preAuthId } });
}

/** Pure predicate — a REQUESTED pre-auth older than staleDays is worth flagging at discharge, without ever auto-transitioning it. */
export function isPreAuthStale(preAuth: { status: string; requestedAt: Date }, atDate: Date, staleDays: number = 7): boolean {
  if (preAuth.status !== "REQUESTED") return false;
  const ageMs = atDate.getTime() - preAuth.requestedAt.getTime();
  return ageMs > staleDays * 24 * 60 * 60 * 1000;
}
