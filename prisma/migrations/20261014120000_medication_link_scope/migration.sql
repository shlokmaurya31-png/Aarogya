-- Medication links get an explicit scope (GLOBAL / ORGANIZATION / FACILITY)
-- and a NULL-free uniqueness key. Before this, a global link was a row with
-- facilityId NULL, and @@unique([facilityId, drugNameKey]) could not stop
-- duplicate global links because Postgres treats NULLs as distinct.

-- CreateEnum
CREATE TYPE "MedicationLinkScope" AS ENUM ('GLOBAL', 'ORGANIZATION', 'FACILITY');

-- DropIndex
DROP INDEX "MedicationItemLink_facilityId_drugNameKey_key";

-- AlterTable: add the columns nullable first, so existing rows can be backfilled.
ALTER TABLE "MedicationItemLink" ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "scope" "MedicationLinkScope" NOT NULL DEFAULT 'FACILITY',
ADD COLUMN     "scopeRef" TEXT;

-- Backfill: a row with a facility is a FACILITY link; a row without one was a
-- GLOBAL link.
UPDATE "MedicationItemLink" SET "scope" = 'FACILITY', "scopeRef" = "facilityId" WHERE "facilityId" IS NOT NULL;
UPDATE "MedicationItemLink" SET "scope" = 'GLOBAL', "scopeRef" = 'GLOBAL' WHERE "facilityId" IS NULL;

ALTER TABLE "MedicationItemLink" ALTER COLUMN "scopeRef" SET NOT NULL;

-- scope, scopeRef and the two ids must agree.
ALTER TABLE "MedicationItemLink" ADD CONSTRAINT "MedicationItemLink_scope_consistent" CHECK (
  ("scope" = 'GLOBAL'       AND "facilityId" IS NULL     AND "organizationId" IS NULL     AND "scopeRef" = 'GLOBAL') OR
  ("scope" = 'ORGANIZATION' AND "facilityId" IS NULL     AND "organizationId" IS NOT NULL AND "scopeRef" = "organizationId") OR
  ("scope" = 'FACILITY'     AND "facilityId" IS NOT NULL AND "organizationId" IS NULL     AND "scopeRef" = "facilityId")
);

-- CreateIndex
CREATE INDEX "MedicationItemLink_facilityId_idx" ON "MedicationItemLink"("facilityId");

-- CreateIndex
CREATE INDEX "MedicationItemLink_organizationId_idx" ON "MedicationItemLink"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "MedicationItemLink_scopeRef_drugNameKey_key" ON "MedicationItemLink"("scopeRef", "drugNameKey");

-- AddForeignKey
ALTER TABLE "MedicationItemLink" ADD CONSTRAINT "MedicationItemLink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
