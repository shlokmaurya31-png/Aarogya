import { Prisma } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

type Tx = Prisma.TransactionClient;

export class PreAuthConcurrencyError extends BadRequestError {
  constructor(action: string) {
    super(`Pre-authorization was already ${action} by someone else, or is no longer in the expected state. Refresh and try again.`);
  }
}

/** Foundation only — manual entry, no live payer API (see PreAuthorization's schema doc comment). */
type PreAuthRow = { id: string; coverageId: string; encounterId: string; status: string; requestedAmountMinor: number; approvedAmountMinor: number | null };

async function preAuthContext(tx: Tx, p: PreAuthRow) {
  const enc = await tx.encounter.findUniqueOrThrow({ where: { id: p.encounterId }, select: { facilityId: true, patientId: true } });
  return { facilityId: enc.facilityId, base: { preAuthId: p.id, coverageId: p.coverageId, encounterId: p.encounterId, patientId: enc.patientId } };
}

/** PreauthStatusChanged (spine §9 step 9): requested or expired; correlated by the encounter. */
async function emitPreAuthStatus(tx: Tx, p: PreAuthRow, from: string | null, byUserId: string | null) {
  const { facilityId, base } = await preAuthContext(tx, p);
  await emitFacilityEvent(tx, {
    type: "PreauthStatusChanged", aggregateId: p.id, facilityId, encounterId: p.encounterId, actorUserId: byUserId,
    payload: { ...base, from, to: p.status, requestedAmountMinor: p.requestedAmountMinor },
  });
}

/** PreauthDecided (spine §9 step 9): the payer's decision. */
async function emitPreAuthDecided(tx: Tx, p: PreAuthRow, byUserId: string | null) {
  const { facilityId, base } = await preAuthContext(tx, p);
  await emitFacilityEvent(tx, {
    type: "PreauthDecided", aggregateId: p.id, facilityId, encounterId: p.encounterId, actorUserId: byUserId,
    payload: { ...base, decision: p.status, ...(p.approvedAmountMinor !== null ? { approvedAmountMinor: p.approvedAmountMinor } : {}) },
  });
}

export async function requestPreAuth(
  tx: Tx,
  input: { coverageId: string; encounterId: string; requestedAmountMinor: number; requestedByUserId: string; payerReferenceNo?: string; notes?: string }
) {
  if (input.requestedAmountMinor <= 0) throw new BadRequestError("requestedAmountMinor must be positive.");
  const preAuth = await tx.preAuthorization.create({
    data: {
      coverageId: input.coverageId,
      encounterId: input.encounterId,
      requestedAmountMinor: input.requestedAmountMinor,
      requestedByUserId: input.requestedByUserId,
      payerReferenceNo: input.payerReferenceNo,
      notes: input.notes,
    },
  });
  await emitPreAuthStatus(tx, preAuth, null, input.requestedByUserId);
  return preAuth;
}

export async function decidePreAuth(tx: Tx, preAuthId: string, input: { status: "APPROVED" | "DENIED"; approvedAmountMinor?: number; byUserId?: string | null }) {
  if (input.status === "APPROVED" && typeof input.approvedAmountMinor !== "number") {
    throw new BadRequestError("approvedAmountMinor is required for an approval.");
  }
  const result = await tx.preAuthorization.updateMany({
    where: { id: preAuthId, status: "REQUESTED" },
    data: { status: input.status, approvedAmountMinor: input.approvedAmountMinor, decidedAt: new Date() },
  });
  if (result.count !== 1) throw new PreAuthConcurrencyError("decided");
  const decided = await tx.preAuthorization.findUniqueOrThrow({ where: { id: preAuthId } });
  await emitPreAuthDecided(tx, decided, input.byUserId ?? null);
  return decided;
}

/** Staff-triggered only — this codebase has no cron/background job anywhere, so EXPIRED is never set automatically. See isPreAuthStale for the live-computed staleness warning used by financialClearance.ts instead. */
export async function expirePreAuth(tx: Tx, preAuthId: string, input: { byUserId?: string | null } = {}) {
  // Compare-and-set on the exact status read, so the event's "from" is the real one.
  const current = await tx.preAuthorization.findUniqueOrThrow({ where: { id: preAuthId } });
  if (current.status !== "REQUESTED" && current.status !== "APPROVED") throw new PreAuthConcurrencyError("expired");
  const result = await tx.preAuthorization.updateMany({
    where: { id: preAuthId, status: current.status },
    data: { status: "EXPIRED", decidedAt: new Date() },
  });
  if (result.count !== 1) throw new PreAuthConcurrencyError("expired");
  const expired = await tx.preAuthorization.findUniqueOrThrow({ where: { id: preAuthId } });
  await emitPreAuthStatus(tx, expired, current.status, input.byUserId ?? null);
  return expired;
}

/** Pure predicate — a REQUESTED pre-auth older than staleDays is worth flagging at discharge, without ever auto-transitioning it. */
export function isPreAuthStale(preAuth: { status: string; requestedAt: Date }, atDate: Date, staleDays: number = 7): boolean {
  if (preAuth.status !== "REQUESTED") return false;
  const ageMs = atDate.getTime() - preAuth.requestedAt.getTime();
  return ageMs > staleDays * 24 * 60 * 60 * 1000;
}
