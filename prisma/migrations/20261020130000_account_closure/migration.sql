-- Phase 0, part 2 (d): account closure. A closed Person keeps nothing visible
-- to anyone; its patient-provided data is deleted after a 30-day grace period
-- (reopening first cancels that). Facility records, and anything a clinician
-- confirmed into them, stay under records retention. Additive.

ALTER TYPE "PersonAccessLogKind" ADD VALUE 'ACCOUNT_CLOSED';
ALTER TYPE "PersonAccessLogKind" ADD VALUE 'ACCOUNT_REOPENED';
ALTER TYPE "PersonUnlinkReason" ADD VALUE 'ACCOUNT_CLOSED';
ALTER TABLE "Person" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "purgeAfter" TIMESTAMP(3),
ADD COLUMN     "purgedAt" TIMESTAMP(3);

-- A closed Person says when, and when its data goes; a purge only follows a closure.
ALTER TABLE "Person" ADD CONSTRAINT "Person_closed_check"
  CHECK (("status" <> 'CLOSED' OR ("closedAt" IS NOT NULL AND "purgeAfter" IS NOT NULL)) AND ("purgedAt" IS NULL OR "status" = 'CLOSED'));
