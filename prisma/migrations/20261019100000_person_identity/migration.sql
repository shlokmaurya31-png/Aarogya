-- Phase 0, part 1 (a): person identity (docs/PERSON_IDENTITY_DESIGN.md).
-- A platform-level Person the patient owns, tied to no facility, and the
-- verified bridge from facility Patient records to it. Additive: no existing
-- row changes meaning; Patient.phoneConfirmedAt starts NULL for every existing
-- record (no confirmation is assumed), and existing accounts get Persons only
-- through the identity migration script, which refuses rather than guesses.

-- CreateEnum
CREATE TYPE "PersonStatus" AS ENUM ('ACTIVE', 'LOCKED', 'MERGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PersonAccountRole" AS ENUM ('OWNER');

-- CreateEnum
CREATE TYPE "PersonContactKind" AS ENUM ('PHONE', 'EMAIL');

-- CreateEnum
CREATE TYPE "PersonContactStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "PersonIdentifierSystem" AS ENUM ('ABHA_NUMBER', 'ABHA_ADDRESS');

-- CreateEnum
CREATE TYPE "PersonPatientLinkStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'UNLINKED', 'SUPERSEDED', 'REVERIFICATION_REQUIRED');

-- CreateEnum
CREATE TYPE "PersonLinkMethod" AS ENUM ('OTP_RECORD_CONTACT', 'ABHA_BOTH_VERIFIED', 'IN_PERSON_ID', 'SELF_CREATED');

-- CreateEnum
CREATE TYPE "PersonLinkInitiator" AS ENUM ('PERSON', 'FACILITY');

-- CreateEnum
CREATE TYPE "PersonSecondFactor" AS ENUM ('DOB', 'UHID');

-- CreateEnum
CREATE TYPE "PersonIdDocumentType" AS ENUM ('AADHAAR', 'PAN', 'PASSPORT', 'VOTER_ID', 'DRIVING_LICENCE', 'OTHER_GOVT');

-- CreateEnum
CREATE TYPE "PersonInPersonReason" AS ENUM ('NO_PHONE_ON_RECORD', 'PHONE_NOT_CONFIRMED', 'PHONE_UNREACHABLE', 'SECOND_FACTOR_UNAVAILABLE');

-- CreateEnum
CREATE TYPE "PersonUnlinkActor" AS ENUM ('PERSON', 'FACILITY', 'PLATFORM');

-- CreateEnum
CREATE TYPE "PersonUnlinkReason" AS ENUM ('PERSON_REQUEST', 'WRONG_PERSON', 'FACILITY_MERGE', 'PERSON_MERGE', 'SECURITY');

-- CreateEnum
CREATE TYPE "PersonAccessLogKind" AS ENUM ('PERSON_CREATED', 'LINK_REQUESTED', 'LINKED', 'LINK_REFUSED', 'UNLINKED', 'REVERIFICATION_REQUIRED', 'CONSENT_DECIDED', 'RECORD_ACCESSED');

-- AlterTable
ALTER TABLE "DomainEventOutbox" ADD COLUMN     "personId" TEXT;

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "phoneConfirmedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PatientLinkRequest" ADD COLUMN     "initiatedBy" "PersonLinkInitiator" NOT NULL DEFAULT 'PERSON',
ADD COLUMN     "method" "PersonLinkMethod",
ADD COLUMN     "personId" TEXT,
ADD COLUMN     "secondFactor" "PersonSecondFactor",
ADD COLUMN     "secondFactorOk" BOOLEAN;

-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL,
    "status" "PersonStatus" NOT NULL DEFAULT 'ACTIVE',
    "mergedIntoPersonId" TEXT,
    "mergedAt" TIMESTAMP(3),
    "displayName" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3),
    "dobPrecision" "DobPrecision",
    "sex" TEXT,
    "preferredLanguage" TEXT NOT NULL DEFAULT 'en',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonAccount" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "PersonAccountRole" NOT NULL DEFAULT 'OWNER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "PersonAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonContact" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "kind" "PersonContactKind" NOT NULL,
    "value" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "status" "PersonContactStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonIdentifier" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "system" "PersonIdentifierSystem" NOT NULL,
    "valueHash" TEXT NOT NULL,
    "valueLast4" TEXT NOT NULL,
    "verificationStatus" "ExternalIdentifierVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" TIMESTAMP(3),
    "verifiedVia" TEXT NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonPatientLink" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "status" "PersonPatientLinkStatus" NOT NULL,
    "method" "PersonLinkMethod",
    "linkRequestId" TEXT,
    "linkedAt" TIMESTAMP(3),
    "linkedByUserId" TEXT,
    "idType" "PersonIdDocumentType",
    "idLast4" TEXT,
    "verifiedByStaffId" TEXT,
    "approvedByStaffId" TEXT,
    "inPersonReason" "PersonInPersonReason",
    "unlinkedAt" TIMESTAMP(3),
    "unlinkedBy" "PersonUnlinkActor",
    "unlinkedReason" "PersonUnlinkReason",
    "unlinkedByUserId" TEXT,
    "unlinkApprovedByUserId" TEXT,
    "supersededByLinkId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonPatientLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonAccessLogEntry" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "kind" "PersonAccessLogKind" NOT NULL,
    "accessingFacilityId" TEXT,
    "actorUserId" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonAccessLogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Person_mergedIntoPersonId_idx" ON "Person"("mergedIntoPersonId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonAccount_userId_key" ON "PersonAccount"("userId");

-- CreateIndex
CREATE INDEX "PersonAccount_personId_idx" ON "PersonAccount"("personId");

-- CreateIndex
CREATE INDEX "PersonContact_personId_idx" ON "PersonContact"("personId");

-- CreateIndex
CREATE INDEX "PersonIdentifier_personId_idx" ON "PersonIdentifier"("personId");

-- CreateIndex
CREATE INDEX "PersonPatientLink_personId_status_idx" ON "PersonPatientLink"("personId", "status");

-- CreateIndex
CREATE INDEX "PersonPatientLink_facilityId_status_idx" ON "PersonPatientLink"("facilityId", "status");

-- CreateIndex
CREATE INDEX "PersonPatientLink_patientId_idx" ON "PersonPatientLink"("patientId");

-- CreateIndex
CREATE INDEX "PersonAccessLogEntry_personId_createdAt_idx" ON "PersonAccessLogEntry"("personId", "createdAt");

-- CreateIndex
CREATE INDEX "DomainEventOutbox_personId_idx" ON "DomainEventOutbox"("personId");

-- AddForeignKey
ALTER TABLE "PatientLinkRequest" ADD CONSTRAINT "PatientLinkRequest_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonAccount" ADD CONSTRAINT "PersonAccount_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonAccount" ADD CONSTRAINT "PersonAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonContact" ADD CONSTRAINT "PersonContact_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonIdentifier" ADD CONSTRAINT "PersonIdentifier_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonPatientLink" ADD CONSTRAINT "PersonPatientLink_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonPatientLink" ADD CONSTRAINT "PersonPatientLink_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonPatientLink" ADD CONSTRAINT "PersonPatientLink_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonAccessLogEntry" ADD CONSTRAINT "PersonAccessLogEntry_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Invariants Prisma can't express ────────────────────────────────────────

-- One active OWNER login per Person.
CREATE UNIQUE INDEX "PersonAccount_one_active_owner" ON "PersonAccount"("personId") WHERE "role" = 'OWNER' AND "endedAt" IS NULL;

-- A verified contact belongs to one Person at a time.
CREATE UNIQUE INDEX "PersonContact_verified_unique" ON "PersonContact"("kind", "value") WHERE "status" = 'ACTIVE' AND "verifiedAt" IS NOT NULL;

-- One verified ABHA, one Person. Only a hash and the last 4 characters are kept.
CREATE UNIQUE INDEX "PersonIdentifier_verified_unique" ON "PersonIdentifier"("system", "valueHash") WHERE "verificationStatus" = 'VERIFIED';
ALTER TABLE "PersonIdentifier" ADD CONSTRAINT "PersonIdentifier_last4_check" CHECK (char_length("valueLast4") <= 4);
-- NONE never counts as verified.
ALTER TABLE "PersonIdentifier" ADD CONSTRAINT "PersonIdentifier_verified_via_check"
  CHECK ("verificationStatus" <> 'VERIFIED' OR ("verifiedVia" = 'ABDM_AUTH' AND "verifiedAt" IS NOT NULL));

-- A merged Person points at its target, and only a merged one does.
ALTER TABLE "Person" ADD CONSTRAINT "Person_merged_check"
  CHECK (("status" = 'MERGED') = ("mergedIntoPersonId" IS NOT NULL));

-- At most one live link per facility record.
CREATE UNIQUE INDEX "PersonPatientLink_one_live_per_patient" ON "PersonPatientLink"("patientId")
  WHERE "status" IN ('PENDING_VERIFICATION', 'ACTIVE', 'REVERIFICATION_REQUIRED');
-- ACTIVE means verified: its method, when and by whom.
ALTER TABLE "PersonPatientLink" ADD CONSTRAINT "PersonPatientLink_active_check"
  CHECK ("status" <> 'ACTIVE' OR ("method" IS NOT NULL AND "linkedAt" IS NOT NULL AND "linkedByUserId" IS NOT NULL));
-- In-person ID verification: the ID type, exactly 4 characters of it, a
-- reason, and two different staff members. ID fields belong to that method only.
ALTER TABLE "PersonPatientLink" ADD CONSTRAINT "PersonPatientLink_in_person_check"
  CHECK ("method" IS DISTINCT FROM 'IN_PERSON_ID' OR (
    "idType" IS NOT NULL AND "idLast4" IS NOT NULL AND "inPersonReason" IS NOT NULL
    AND "verifiedByStaffId" IS NOT NULL AND "approvedByStaffId" IS NOT NULL
    AND "verifiedByStaffId" <> "approvedByStaffId"));
ALTER TABLE "PersonPatientLink" ADD CONSTRAINT "PersonPatientLink_id_fields_check"
  CHECK (("idType" IS NULL AND "idLast4" IS NULL) OR "method" = 'IN_PERSON_ID');
ALTER TABLE "PersonPatientLink" ADD CONSTRAINT "PersonPatientLink_id_last4_check"
  CHECK ("idLast4" IS NULL OR "idLast4" ~ '^[A-Za-z0-9]{4}$');
-- An unlinked link says when, by whom and why; a facility unlink needs a
-- second, different approver.
ALTER TABLE "PersonPatientLink" ADD CONSTRAINT "PersonPatientLink_unlinked_check"
  CHECK ("status" <> 'UNLINKED' OR ("unlinkedAt" IS NOT NULL AND "unlinkedBy" IS NOT NULL AND "unlinkedReason" IS NOT NULL AND "unlinkedByUserId" IS NOT NULL));
ALTER TABLE "PersonPatientLink" ADD CONSTRAINT "PersonPatientLink_facility_unlink_check"
  CHECK ("unlinkedBy" IS DISTINCT FROM 'FACILITY' OR ("unlinkApprovedByUserId" IS NOT NULL AND "unlinkApprovedByUserId" <> "unlinkedByUserId"));

-- The link's facility is its patient's facility.
CREATE FUNCTION "PersonPatientLink_facility_matches"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Patient" p WHERE p."id" = NEW."patientId" AND p."facilityId" = NEW."facilityId") THEN
    RAISE EXCEPTION 'PersonPatientLink.facilityId must equal the patient''s facility' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PersonPatientLink_facility_matches_trg" BEFORE INSERT OR UPDATE OF "patientId", "facilityId" ON "PersonPatientLink"
  FOR EACH ROW EXECUTE FUNCTION "PersonPatientLink_facility_matches"();

-- A second factor's result needs the factor.
ALTER TABLE "PatientLinkRequest" ADD CONSTRAINT "PatientLinkRequest_second_factor_check"
  CHECK ("secondFactorOk" IS NULL OR "secondFactor" IS NOT NULL);
