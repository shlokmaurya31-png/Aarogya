import type { Prisma, UnitOfMeasure } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";
import { convertToBaseUnit } from "./units";
import { selectFefoLot, validateExplicitLot } from "./fefo";
import { getOrCreateStockBalance, atomicDecrementOnHand } from "./stockBalance";
import { postLedgerEntry } from "./ledger";
import { assertItemInFacility, assertLocationInFacility, assertLotInFacility } from "./facilityScope";

type Tx = Prisma.TransactionClient;

export interface IssueStockInput {
  facilityId: string;
  itemId: string;
  locationId: string;
  quantity: number;
  unit?: UnitOfMeasure; // defaults to the item's baseUnit; converted via units.ts if different
  lotId?: string; // explicit override; omitted => FEFO
  requestedByStaffId: string;
  actorUserId: string;
  reason?: string;
  patientId?: string;
  encounterId?: string;
  sourceType: string;
  sourceId: string;
}

/**
 * The generic stock-consumption boundary the brief asks for (Lab/
 * Radiology/OT/ward issue all call this same function, whether or not
 * they have dedicated UI yet). Pharmacy dispensing is the one caller wired
 * up this phase — see medicationLifecycle.ts#dispenseMedication.
 *
 * Never issues expired or quarantined stock (fefo.ts's validation runs
 * unconditionally, whether the lot was FEFO-selected or explicitly
 * chosen). Never over-issues — atomicDecrementOnHand's guarded UPDATE is
 * the actual concurrency-safe enforcement, not a prior SELECT check.
 */
export async function issueStock(tx: Tx, input: IssueStockInput) {
  if (input.quantity <= 0) throw new BadRequestError("Issue quantity must be positive.");

  // Idempotency check FIRST, before touching any balance — a retry of the
  // same source event (e.g. a network retry re-invoking dispenseMedication)
  // must not decrement stock twice just because it's the ledger row that's
  // deduplicated. postLedgerEntry's own ON CONFLICT DO NOTHING is the
  // backstop for a genuine race between this check and the eventual
  // insert below, not the primary idempotency mechanism for a simple
  // sequential retry.
  const existing = await tx.stockLedgerEntry.findFirst({ where: { sourceType: input.sourceType, sourceId: input.sourceId, movementType: "ISSUE" } });
  if (existing) return { lotId: existing.lotId, quantity: -existing.onHandDelta, alreadyExisted: true as const };

  const item = await assertItemInFacility(tx, input.itemId, input.facilityId);
  await assertLocationInFacility(tx, input.locationId, input.facilityId);
  if (input.lotId) await assertLotInFacility(tx, input.lotId, input.facilityId);
  const baseQuantity = input.unit ? await convertToBaseUnit(tx, item, input.quantity, input.unit) : input.quantity;

  const lotId = input.lotId ?? (await selectFefoLot(tx, { itemId: input.itemId, locationId: input.locationId, quantity: baseQuantity })).lotId;
  await validateExplicitLot(tx, lotId);

  const balance = await getOrCreateStockBalance(tx, { facilityId: input.facilityId, itemId: input.itemId, lotId, locationId: input.locationId });
  await atomicDecrementOnHand(tx, balance.id, baseQuantity);

  const { alreadyExisted } = await postLedgerEntry(tx, {
    facilityId: input.facilityId,
    itemId: input.itemId,
    lotId,
    locationId: input.locationId,
    movementType: "ISSUE",
    onHandDelta: -baseQuantity,
    unit: item.baseUnit,
    reason: input.reason,
    patientId: input.patientId,
    encounterId: input.encounterId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    actorUserId: input.actorUserId,
    actorStaffId: input.requestedByStaffId,
  });

  return { lotId, quantity: baseQuantity, alreadyExisted };
}

/** Alias matching the brief's own conceptual naming — same function, no behavioral difference. */
export const consumeInventory = issueStock;
