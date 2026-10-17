import { prisma } from "../../src/lib/db";
import { getOrCreateStockBalance, atomicIncrementOnHand } from "../../src/lib/hospital/inventory/stockBalance";
import { postLedgerEntry } from "../../src/lib/hospital/inventory/ledger";

/**
 * Gate fixture stock (batch 7, item 2): on-hand quantity added the way real
 * stock arrives, a balance increment plus its ledger entry (an ADJUSTMENT keyed
 * to the fixture), so the ledger and StockBalance always reconcile. Works for
 * lots the services refuse to move (expired, quarantined), which the security
 * gates need on hand to prove they can't be issued.
 */
export async function seedFixtureStock(input: { facilityId: string; itemId: string; lotId: string; locationId: string; quantity: number; actorUserId: string; key: string }) {
  return prisma.$transaction(async (tx) => {
    const item = await tx.item.findUniqueOrThrow({ where: { id: input.itemId }, select: { baseUnit: true } });
    const balance = await getOrCreateStockBalance(tx, { facilityId: input.facilityId, itemId: input.itemId, lotId: input.lotId, locationId: input.locationId });
    await atomicIncrementOnHand(tx, balance.id, input.quantity);
    await postLedgerEntry(tx, {
      facilityId: input.facilityId, itemId: input.itemId, lotId: input.lotId, locationId: input.locationId,
      movementType: "ADJUSTMENT", onHandDelta: input.quantity, unit: item.baseUnit, adjustmentReason: "FOUND",
      sourceType: "GateFixture", sourceId: input.key, actorUserId: input.actorUserId,
    });
    return balance;
  });
}
