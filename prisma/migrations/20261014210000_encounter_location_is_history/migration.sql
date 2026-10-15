-- D5: EncounterLocation is the only location history. A Transfer records the
-- move (who, why, which request) and points at the location rows it closed and
-- opened; its own from/to bed and time columns go.
--
-- Backfill: transferPatient has always closed the open location and opened
-- one at the destination bed in the same transaction as the Transfer, so each
-- Transfer is matched to the destination-bed location of its encounter
-- assigned closest to transferredAt (within a minute), and the origin-bed
-- location released closest to it. A Transfer with no destination location is
-- inconsistent history; the migration stops rather than invent it.

ALTER TABLE "Transfer" ADD COLUMN "fromLocationId" TEXT, ADD COLUMN "toLocationId" TEXT;

UPDATE "Transfer" t SET "toLocationId" = (
  SELECT l."id" FROM "EncounterLocation" l JOIN "Admission" a ON a."id" = t."admissionId"
  WHERE l."encounterId" = a."encounterId" AND l."bedId" = t."toBedId"
    AND abs(extract(epoch FROM l."assignedAt" - t."transferredAt")) < 60
  ORDER BY abs(extract(epoch FROM l."assignedAt" - t."transferredAt")), l."id" LIMIT 1
);
UPDATE "Transfer" t SET "fromLocationId" = (
  SELECT l."id" FROM "EncounterLocation" l JOIN "Admission" a ON a."id" = t."admissionId"
  WHERE l."encounterId" = a."encounterId" AND l."bedId" = t."fromBedId" AND l."releasedAt" IS NOT NULL
    AND abs(extract(epoch FROM l."releasedAt" - t."transferredAt")) < 60
  ORDER BY abs(extract(epoch FROM l."releasedAt" - t."transferredAt")), l."id" LIMIT 1
);

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "Transfer" WHERE "toLocationId" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'D5: % transfer(s) have no matching EncounterLocation at the destination bed; resolve before migrating', n; END IF;
  SELECT count(*) INTO n FROM (SELECT "toLocationId" FROM "Transfer" GROUP BY 1 HAVING count(*) > 1) d;
  IF n > 0 THEN RAISE EXCEPTION 'D5: % location(s) match more than one transfer; resolve before migrating', n; END IF;
  -- Two transfers can't claim one origin row; keep the closest and leave the other unlinked.
  UPDATE "Transfer" t SET "fromLocationId" = NULL
  WHERE "fromLocationId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Transfer" o WHERE o."fromLocationId" = t."fromLocationId" AND o."id" < t."id"
  );
END $$;

ALTER TABLE "Transfer" ALTER COLUMN "toLocationId" SET NOT NULL;
CREATE UNIQUE INDEX "Transfer_fromLocationId_key" ON "Transfer"("fromLocationId");
CREATE UNIQUE INDEX "Transfer_toLocationId_key" ON "Transfer"("toLocationId");
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "EncounterLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "EncounterLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Transfer" DROP CONSTRAINT "Transfer_fromBedId_fkey";
ALTER TABLE "Transfer" DROP CONSTRAINT "Transfer_toBedId_fkey";
ALTER TABLE "Transfer" DROP COLUMN "fromBedId", DROP COLUMN "toBedId", DROP COLUMN "transferredAt";
