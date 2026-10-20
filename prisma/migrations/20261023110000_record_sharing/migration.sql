-- Week 4c: consent sharing (docs/CONSENT_SHARING_DESIGN.md §3). Additive:
-- codes issued before 4c keep a NULL shareId and read under the restricted
-- default scope (§4.3); no share is invented for them.

-- CreateEnum
CREATE TYPE "RecordShareKind" AS ENUM ('CODE', 'REQUEST');

-- CreateEnum
CREATE TYPE "RecordShareStatus" AS ENUM ('PENDING', 'ACTIVE', 'ENDED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ShareCategory" AS ENUM ('PRESCRIPTIONS', 'LABS', 'IMAGING', 'DISCHARGE_SUMMARIES', 'UPLOADS');

-- CreateEnum
CREATE TYPE "SharePurpose" AS ENUM ('CONSULTATION', 'SECOND_OPINION', 'FOLLOW_UP', 'REFERRAL', 'OTHER');

-- CreateEnum
CREATE TYPE "ShareEndReason" AS ENUM ('VISIT_ENDED', 'EXPIRED', 'PATIENT_ENDED', 'REVOKE_ALL', 'PERSON_CLOSED');

-- CreateEnum
CREATE TYPE "AccessRequesterKind" AS ENUM ('DOCTOR', 'FACILITY');

-- CreateEnum
CREATE TYPE "AccessRequestStatus" AS ENUM ('REQUESTED', 'APPROVED', 'DECLINED', 'CANCELLED', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PersonAccessLogKind" ADD VALUE 'SHARE_CREATED';
ALTER TYPE "PersonAccessLogKind" ADD VALUE 'SHARE_ENDED';
ALTER TYPE "PersonAccessLogKind" ADD VALUE 'ACCESS_REQUESTED';
ALTER TYPE "PersonAccessLogKind" ADD VALUE 'ACCESS_REQUEST_DECIDED';
ALTER TYPE "PersonAccessLogKind" ADD VALUE 'ACCESS_REVOKED_ALL';

-- AlterTable
ALTER TABLE "PatientAccessSession" ADD COLUMN     "shareId" TEXT;

-- CreateTable
CREATE TABLE "RecordShare" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "kind" "RecordShareKind" NOT NULL,
    "status" "RecordShareStatus" NOT NULL DEFAULT 'PENDING',
    "purpose" "SharePurpose" NOT NULL,
    "categories" "ShareCategory"[],
    "sensitiveCategories" "RagSensitiveCategory"[] DEFAULT ARRAY[]::"RagSensitiveCategory"[],
    "recordedFrom" TIMESTAMP(3),
    "recordedTo" TIMESTAMP(3),
    "patientIds" TEXT[],
    "recipientUserId" TEXT,
    "recipientFacilityId" TEXT,
    "accessRequestId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedReason" "ShareEndReason",
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "RecordShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessRequest" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "requesterKind" "AccessRequesterKind" NOT NULL,
    "requesterUserId" TEXT NOT NULL,
    "requesterFacilityId" TEXT NOT NULL,
    "purpose" "SharePurpose" NOT NULL,
    "categories" "ShareCategory"[],
    "recordedFrom" TIMESTAMP(3),
    "recordedTo" TIMESTAMP(3),
    "reason" TEXT,
    "status" "AccessRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecordShare_accessRequestId_key" ON "RecordShare"("accessRequestId");

-- CreateIndex
CREATE INDEX "RecordShare_personId_status_idx" ON "RecordShare"("personId", "status");

-- CreateIndex
CREATE INDEX "RecordShare_recipientUserId_status_idx" ON "RecordShare"("recipientUserId", "status");

-- CreateIndex
CREATE INDEX "RecordShare_recipientFacilityId_status_idx" ON "RecordShare"("recipientFacilityId", "status");

-- CreateIndex
CREATE INDEX "RecordShare_status_expiresAt_idx" ON "RecordShare"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "AccessRequest_personId_status_idx" ON "AccessRequest"("personId", "status");

-- CreateIndex
CREATE INDEX "AccessRequest_requesterFacilityId_status_idx" ON "AccessRequest"("requesterFacilityId", "status");

-- CreateIndex
CREATE INDEX "AccessRequest_status_expiresAt_idx" ON "AccessRequest"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PatientAccessSession_shareId_key" ON "PatientAccessSession"("shareId");

-- AddForeignKey
ALTER TABLE "PatientAccessSession" ADD CONSTRAINT "PatientAccessSession_shareId_fkey" FOREIGN KEY ("shareId") REFERENCES "RecordShare"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordShare" ADD CONSTRAINT "RecordShare_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A share or request names at least one category, and a period runs forwards.
ALTER TABLE "RecordShare" ADD CONSTRAINT "RecordShare_categories_check" CHECK (cardinality("categories") >= 1);
ALTER TABLE "RecordShare" ADD CONSTRAINT "RecordShare_period_check" CHECK ("recordedFrom" IS NULL OR "recordedTo" IS NULL OR "recordedFrom" <= "recordedTo");
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_categories_check" CHECK (cardinality("categories") >= 1);
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_period_check" CHECK ("recordedFrom" IS NULL OR "recordedTo" IS NULL OR "recordedFrom" <= "recordedTo");
-- One open request per requester and person (§5).
CREATE UNIQUE INDEX "AccessRequest_one_open_per_requester" ON "AccessRequest"("personId", "requesterUserId") WHERE "status" = 'REQUESTED';
