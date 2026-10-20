import { prisma } from "@/lib/db";
import type { DomainEventConsumer } from "@/lib/events/consumers";
import { deliverPersonNotification, queuePersonNotificationTx } from "@/lib/person/notifications";

/**
 * person-notifier (4c answers, docs/CONSENT_SHARING_DESIGN.md §15): tells the
 * person about access to their record.
 *   BreakGlassStatusChanged (to ACTIVE)  → BREAK_GLASS_ACCESS at once, for the
 *                                          Person linked to that record
 *   AccessRequested                      → ACCESS_REQUESTED at once
 *   PersonNotificationQueued             → deliver it (email, else a verified phone)
 * The daily summary is written by the runner's sweep and delivered here too.
 * Idempotent: one notification per fact (dedupeKey) and delivery only from PENDING.
 */
export const personNotifier: DomainEventConsumer = {
  name: "person-notifier",
  handles: ["BreakGlassStatusChanged", "AccessRequested", "PersonNotificationQueued"],
  async handle(event) {
    const p = event.payload as Record<string, unknown>;
    if (event.eventType === "PersonNotificationQueued") {
      await deliverPersonNotification(String(p.notificationId));
      return;
    }
    if (event.eventType === "AccessRequested") {
      await prisma.$transaction((tx) => queuePersonNotificationTx(tx, { personId: String(p.personId), kind: "ACCESS_REQUESTED", dedupeKey: `ACCESS_REQUESTED:${String(p.requestId)}` }));
      return;
    }
    // Break-glass: only its start is news to the person; the person is whoever owns that record now.
    if (p.to !== "ACTIVE" || p.from !== null) return;
    const link = await prisma.personPatientLink.findFirst({ where: { patientId: String(p.patientId), status: "ACTIVE" }, select: { personId: true } });
    if (!link) return;
    await prisma.$transaction((tx) => queuePersonNotificationTx(tx, { personId: link.personId, kind: "BREAK_GLASS_ACCESS", dedupeKey: `BREAK_GLASS:${String(p.breakGlassId)}` }));
  },
};
