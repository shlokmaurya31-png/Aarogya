-- Patient age is calculated from dob, never stored. An age given without a
-- date of birth becomes an estimated dob (same day and month as when the age
-- was recorded, that many years earlier). dobPrecision folds into
-- dobEstimated. StudentProfile's names move to User (legalName, displayName).

ALTER TABLE "Patient" ADD COLUMN "dobEstimated" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Patient" SET "dobEstimated" = true
WHERE "dob" IS NOT NULL AND "dobPrecision" IN ('APPROXIMATE', 'UNKNOWN');

UPDATE "Patient"
SET "dob" = date_trunc('day', "createdAt") - make_interval(years => "ageYears"), "dobEstimated" = true
WHERE "dob" IS NULL AND "ageYears" IS NOT NULL;

ALTER TABLE "Patient" DROP COLUMN "ageYears", DROP COLUMN "dobPrecision";

ALTER TABLE "User" ADD COLUMN "legalName" TEXT;
UPDATE "User" u SET "legalName" = s."fullLegalName",
  "displayName" = COALESCE(NULLIF(trim(s."preferredName"), ''), u."displayName")
FROM "StudentProfile" s WHERE s."userId" = u."id";
ALTER TABLE "StudentProfile" DROP COLUMN "fullLegalName", DROP COLUMN "preferredName";
