-- Phase 0, part 1 (c): linking a facility record to a Person.
-- Link requests gain two routes: SECOND_FACTOR_REQUIRED (a phone confirmed
-- within 12 months: date of birth or UHID first, then a code) and
-- IN_PERSON_REQUIRED (verify at the front desk). A facility unlink waits for
-- a second, different staff member. An in-person verification is recorded by
-- one staff member and approved by another before the person confirms it, so
-- the approver is required once the link is ACTIVE (and is never the same
-- staff member). Additive: no existing row changes.

ALTER TYPE "PatientLinkStatus" ADD VALUE 'SECOND_FACTOR_REQUIRED';
ALTER TYPE "PatientLinkStatus" ADD VALUE 'IN_PERSON_REQUIRED';

ALTER TABLE "PersonPatientLink" ADD COLUMN     "unlinkRequestedAt" TIMESTAMP(3),
ADD COLUMN     "unlinkRequestedByUserId" TEXT,
ADD COLUMN     "unlinkRequestedReason" "PersonUnlinkReason";

-- In-person ID: the type, its 4 characters, a reason and the verifying staff
-- member always; the approver (a different staff member) once ACTIVE.
ALTER TABLE "PersonPatientLink" DROP CONSTRAINT "PersonPatientLink_in_person_check";
ALTER TABLE "PersonPatientLink" ADD CONSTRAINT "PersonPatientLink_in_person_check"
  CHECK ("method" IS DISTINCT FROM 'IN_PERSON_ID' OR (
    "idType" IS NOT NULL AND "idLast4" IS NOT NULL AND "inPersonReason" IS NOT NULL AND "verifiedByStaffId" IS NOT NULL
    AND ("status" <> 'ACTIVE' OR "approvedByStaffId" IS NOT NULL)
    AND ("approvedByStaffId" IS NULL OR "approvedByStaffId" <> "verifiedByStaffId")));

-- A requested facility unlink names its requester, time and reason together,
-- and the approver differs from the requester.
ALTER TABLE "PersonPatientLink" ADD CONSTRAINT "PersonPatientLink_unlink_request_check"
  CHECK ((("unlinkRequestedByUserId" IS NULL) = ("unlinkRequestedAt" IS NULL)) AND (("unlinkRequestedAt" IS NULL) = ("unlinkRequestedReason" IS NULL)));
ALTER TABLE "PersonPatientLink" ADD CONSTRAINT "PersonPatientLink_unlink_approver_check"
  CHECK ("unlinkApprovedByUserId" IS NULL OR "unlinkRequestedByUserId" IS NULL OR "unlinkApprovedByUserId" <> "unlinkRequestedByUserId");
