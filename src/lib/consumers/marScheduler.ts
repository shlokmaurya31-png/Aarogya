import { prisma } from "@/lib/db";
import type { DomainEventConsumer } from "@/lib/events/consumers";
import { PermanentEventError } from "@/lib/events/types";
import { generateAdministrationSchedule } from "@/lib/hospital/medicationSchedule";

/** Order statuses a verified order can be in when its schedule is generated. */
const SCHEDULABLE = ["VERIFIED", "DISPENSED", "ACTIVE"] as const;

/**
 * mar-scheduler (workflow spine §2): on MedicationVerified, writes the order's
 * scheduled doses (status DUE). A dose is only scheduled once pharmacy has
 * verified the order.
 *
 * Idempotent: dose times are computed from the event's occurredAt (not "now"),
 * and (medicationOrderId, scheduledAt) is unique for scheduled doses, so a
 * redelivery inserts nothing. Re-reads the order and checks the event's
 * tenant; an order that is no longer schedulable (cancelled, discontinued) is
 * processed with nothing scheduled (checked under a row lock on the order).
 */
export const marScheduler: DomainEventConsumer = {
  name: "mar-scheduler",
  handles: ["MedicationVerified"],
  async handle(event) {
    const { orderId } = event.payload as { orderId: string };
    const order = await prisma.medicationOrder.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, frequency: true, encounter: { select: { facilityId: true } } },
    });
    if (!order || order.encounter.facilityId !== event.facilityId) {
      throw new PermanentEventError(`Medication order ${orderId} is not in the event's facility.`, "TENANT_MISMATCH");
    }
    // Lock the order row so a concurrent cancel/discontinue (which updates it
    // and cancels future doses in its own transaction) is ordered with us: it
    // either sees our doses and cancels them, or we see its status and stop.
    await prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM "MedicationOrder" WHERE id = ${order.id} FOR UPDATE`;
      if (!locked || !(SCHEDULABLE as readonly string[]).includes(locked.status)) return;
      await generateAdministrationSchedule(order.id, order.frequency, 3, { from: event.occurredAt, db: tx });
    });
  },
};
