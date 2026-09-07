import type { Prisma } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";
import { computeAvailable } from "./stockBalance";
import { ensureLotExpiryState } from "./lots";

type Tx = Prisma.TransactionClient;

export class NoEligibleLotError extends BadRequestError {
  constructor(itemId: string, locationId: string, quantity: number) {
    super(`No lot at this location has ${quantity} available for item ${itemId}/location ${locationId} (checked ACTIVE, non-expired lots only).`);
  }
}

export class ExpiredLotError extends BadRequestError {
  constructor(lotId: string) {
    super(`Lot ${lotId} is expired and cannot be issued through ordinary workflows.`);
  }
}

export class QuarantinedLotError extends BadRequestError {
  constructor(lotId: string) {
    super(`Lot ${lotId} is quarantined and cannot be issued.`);
  }
}

export interface FefoCandidate {
  lotId: string;
  lotStatus: string;
  expiresAt: Date | null;
  onHandQty: number;
  reservedQty: number;
}

/** Pure eligibility check — never expired, never quarantined (or any non-ACTIVE status), must have enough available. Exported so it's unit-testable without a database. */
export function isLotEligible(candidate: FefoCandidate, quantity: number, now: Date = new Date()): boolean {
  if (candidate.lotStatus !== "ACTIVE") return false;
  if (candidate.expiresAt && candidate.expiresAt.getTime() <= now.getTime()) return false;
  return computeAvailable(candidate) >= quantity;
}

/** Pure FEFO comparator — earliest expiry first, null expiry sorts last (never-expires stock is the least urgent to use), deterministic tiebreak on lotId so the choice is reproducible, not iteration-order-dependent. Exported so it's unit-testable without a database. */
export function compareLotsForFefo(a: FefoCandidate, b: FefoCandidate): number {
  const aExp = a.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const bExp = b.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (aExp !== bExp) return aExp - bExp;
  return a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0;
}

/**
 * First-Expiry-First-Out lot selection. This only SELECTS a candidate — it
 * does not reserve/decrement anything; the caller (issue.ts/
 * reservation.ts) still goes through the atomic guarded primitives in
 * stockBalance.ts, so a lot chosen here that loses a concurrent race to
 * another request simply surfaces as InsufficientStockError, not silent
 * corruption.
 */
export async function selectFefoLot(
  tx: Tx,
  input: { itemId: string; locationId: string; quantity: number }
): Promise<{ lotId: string }> {
  const balances = await tx.stockBalance.findMany({
    where: { itemId: input.itemId, locationId: input.locationId },
    include: { lot: true },
  });

  const eligible = balances
    .map((b) => ({ lotId: b.lotId, lotStatus: b.lot.status, expiresAt: b.lot.expiresAt, onHandQty: b.onHandQty, reservedQty: b.reservedQty }))
    .filter((c) => isLotEligible(c, input.quantity))
    .sort(compareLotsForFefo);

  if (eligible.length === 0) throw new NoEligibleLotError(input.itemId, input.locationId, input.quantity);
  return { lotId: eligible[0].lotId };
}

/** Explicit-lot override path (an authorized staff member bypasses FEFO) — still validates ACTIVE/not-expired, never silently issues expired or quarantined stock even when explicitly selected. */
export async function validateExplicitLot(tx: Tx, lotId: string): Promise<void> {
  const lot = await ensureLotExpiryState(tx, lotId);
  if (lot.status === "QUARANTINED") throw new QuarantinedLotError(lotId);
  if (lot.status === "EXPIRED" || (lot.expiresAt && lot.expiresAt.getTime() <= Date.now())) throw new ExpiredLotError(lotId);
  if (lot.status !== "ACTIVE") throw new BadRequestError(`Lot ${lotId} is not in an issuable state (${lot.status}).`);
}
