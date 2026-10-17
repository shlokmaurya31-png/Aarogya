import { prisma } from "@/lib/db";
import type { DomainEventConsumer } from "@/lib/events/consumers";
import { PermanentEventError } from "@/lib/events/types";
import { issueStock } from "@/lib/hospital/inventory/issue";
import { createTask } from "@/lib/hospital/task";

/**
 * stock-movement (workflow spine §2): issues the stock a recorded theatre
 * usage consumed (SurgeryItemUsed with an issuing location), through the
 * canonical issueStock (FEFO, expiry, quarantine, never over-issues).
 *
 * Idempotent: the ledger entry is keyed (SurgeryItemUsage, usageId) and
 * issueStock returns the existing one on redelivery; stockConsumed is set in
 * the same transaction. When the stock is not there (none left, expired,
 * quarantined) the clinical record stands — it is never rolled back: the
 * consumer opens an INVENTORY_EXCEPTION task for the store (once, keyed by the
 * usage) and dead-letters, so the shortfall is visible and replayable once
 * stock is corrected. Re-reads the usage and checks the event's tenant.
 *
 * MedicationDispensed is not consumed here: dispensing still issues stock in
 * its own transaction (§5.2), and no dispensing path has been migrated.
 */
export const stockMovement: DomainEventConsumer = {
  name: "stock-movement",
  handles: ["SurgeryItemUsed"],
  async handle(event) {
    const p = event.payload as { usageId: string; locationId?: string };
    if (!p.locationId) return; // recorded without an issuing location: nothing to move
    const usage = await prisma.surgeryItemUsage.findUnique({ where: { id: p.usageId } });
    if (!usage || usage.facilityId !== event.facilityId) throw new PermanentEventError(`Item usage ${p.usageId} is not in the event's facility.`, "TENANT_MISMATCH");
    if (usage.stockConsumed) return;
    // The ledger records who moved the stock: the event's actor, else the staff member who recorded the usage.
    const actorUserId = event.actorUserId ?? (await prisma.hospitalStaffProfile.findUniqueOrThrow({ where: { id: usage.recordedByStaffId }, select: { userId: true } })).userId;
    try {
      await prisma.$transaction(async (tx) => {
        await issueStock(tx, {
          facilityId: usage.facilityId, itemId: usage.itemId, locationId: p.locationId!, quantity: usage.quantity, lotId: usage.itemLotId ?? undefined,
          requestedByStaffId: usage.recordedByStaffId, actorUserId, reason: `Surgery ${usage.usageType.toLowerCase()}`,
          patientId: usage.patientId, encounterId: usage.encounterId, sourceType: "SurgeryItemUsage", sourceId: usage.id,
        });
        await tx.surgeryItemUsage.update({ where: { id: usage.id }, data: { stockConsumed: true } });
      });
    } catch (err) {
      // A stock problem (400-class from inventory) is not transient: raise it and dead-letter.
      if ((err as { status?: number }).status !== 400) throw err;
      await prisma.$transaction((tx) => createTask(tx, {
        facilityId: usage.facilityId, patientId: usage.patientId, encounterId: usage.encounterId,
        type: "INVENTORY_EXCEPTION", title: "Theatre usage could not be issued from stock", priority: "URGENT",
        source: "EVENT", idempotencyKey: `INVENTORY_EXCEPTION:${usage.id}`,
      }));
      throw new PermanentEventError(`Stock for item usage ${usage.id} could not be issued: ${(err as Error).message}`, "STOCK_UNAVAILABLE");
    }
  },
};
