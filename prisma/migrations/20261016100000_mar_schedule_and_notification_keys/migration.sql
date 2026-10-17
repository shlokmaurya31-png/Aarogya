-- Workflow spine §9 step 6: the mar-scheduler consumer, the MAR missed-dose
-- sweep and the notification-dispatch consumer.
--
-- 1. A scheduled dose is unique per (order, scheduledAt), so the mar-scheduler
--    consumer is idempotent under redelivery. Late recordings of a swept MISSED
--    dose are separate rows linked to it (never a rewrite of the missed row) and
--    are outside that key.
-- 2. A notification is unique per (source event, recipient), so the
--    notification-dispatch consumer is idempotent under redelivery.
--
-- Refuses rather than guesses: duplicate scheduled doses are named and must be
-- resolved by hand; nothing is deleted or merged here.

DO $$
DECLARE dup text;
BEGIN
  SELECT string_agg(format('order %s at %s (%s rows)', "medicationOrderId", "scheduledAt", n), '; ')
    INTO dup
    FROM (
      SELECT "medicationOrderId", "scheduledAt", count(*) AS n
        FROM "MedicationAdministration"
       GROUP BY 1, 2
      HAVING count(*) > 1
       ORDER BY 1, 2
       LIMIT 20
    ) d;
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'MedicationAdministration has more than one dose for the same order and time; resolve these by hand first: %', dup;
  END IF;
END $$;

ALTER TABLE "MedicationAdministration" ADD COLUMN "lateForAdministrationId" TEXT;
CREATE UNIQUE INDEX "MedicationAdministration_lateForAdministrationId_key" ON "MedicationAdministration"("lateForAdministrationId");
ALTER TABLE "MedicationAdministration" ADD CONSTRAINT "MedicationAdministration_lateForAdministrationId_fkey"
  FOREIGN KEY ("lateForAdministrationId") REFERENCES "MedicationAdministration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Partial: cannot be expressed in schema.prisma (see its header).
CREATE UNIQUE INDEX "MedicationAdministration_order_scheduledAt_key"
  ON "MedicationAdministration"("medicationOrderId", "scheduledAt")
  WHERE "lateForAdministrationId" IS NULL;

ALTER TABLE "Notification" ADD COLUMN "sourceEventId" TEXT;
CREATE UNIQUE INDEX "Notification_sourceEventId_recipientStaffId_key" ON "Notification"("sourceEventId", "recipientStaffId");
