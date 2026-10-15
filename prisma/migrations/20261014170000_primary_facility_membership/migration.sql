-- D8: FacilityMembership is the only source of staff facility access. The
-- staff profile's home facility becomes an isPrimary flag on exactly one
-- membership, and HospitalStaffProfile.facilityId is dropped.

-- AlterTable
ALTER TABLE "FacilityMembership" ADD COLUMN     "isPrimary" BOOLEAN NOT NULL DEFAULT false;

-- Backfill 1: every staff profile has a membership at its home facility.
INSERT INTO "FacilityMembership" ("id", "userId", "facilityId", "isAdmin", "status", "createdAt", "updatedAt")
SELECT 'mig-' || md5(s."userId" || ':' || s."facilityId"), s."userId", s."facilityId", false, 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "HospitalStaffProfile" s
WHERE NOT EXISTS (
  SELECT 1 FROM "FacilityMembership" m WHERE m."userId" = s."userId" AND m."facilityId" = s."facilityId"
);

-- Backfill 2: that membership is the primary one.
UPDATE "FacilityMembership" m SET "isPrimary" = true
FROM "HospitalStaffProfile" s
WHERE m."userId" = s."userId" AND m."facilityId" = s."facilityId";

-- At most one primary membership per user. A partial unique index: Prisma's
-- schema can't express it, and migrate diff leaves it alone.
CREATE UNIQUE INDEX "FacilityMembership_one_primary_per_user" ON "FacilityMembership"("userId") WHERE "isPrimary";

-- DropForeignKey
ALTER TABLE "HospitalStaffProfile" DROP CONSTRAINT "HospitalStaffProfile_facilityId_fkey";

-- DropIndex
DROP INDEX "HospitalStaffProfile_facilityId_idx";

-- AlterTable
ALTER TABLE "HospitalStaffProfile" DROP COLUMN "facilityId";
