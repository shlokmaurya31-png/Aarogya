-- Week 5a: the doctor network (docs/DOCTOR_NETWORK_DESIGN.md §14). Additive: new
-- platform-scoped models, the BOOKING share kind and its end reason, and
-- RecordShare.validFrom (null for every existing share: no change to them).
-- CreateEnum
CREATE TYPE "DoctorVerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'SUSPENDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DoctorStaffLinkStatus" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED', 'ENDED');

-- CreateEnum
CREATE TYPE "PracticeLocationKind" AS ENUM ('HOSPITAL', 'CLINIC');

-- CreateEnum
CREATE TYPE "ConsultMode" AS ENUM ('IN_PERSON', 'VIDEO');

-- CreateEnum
CREATE TYPE "DoctorVerificationCaseStatus" AS ENUM ('OPEN', 'APPROVED', 'REJECTED', 'INFO_REQUESTED');

-- AlterEnum
ALTER TYPE "RecordShareKind" ADD VALUE 'BOOKING';

-- AlterEnum
ALTER TYPE "ShareEndReason" ADD VALUE 'APPOINTMENT_CANCELLED';

-- AlterTable
ALTER TABLE "RecordShare" ADD COLUMN     "validFrom" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DoctorProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "registrationNumber" TEXT NOT NULL,
    "stateCouncil" TEXT NOT NULL,
    "registrationYear" INTEGER,
    "verificationStatus" "DoctorVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" TIMESTAMP(3),
    "verificationMethod" TEXT,
    "hprId" TEXT,
    "languages" TEXT[],
    "listed" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DoctorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctorQualification" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "degree" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "year" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoctorQualification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctorSpecialty" (
    "doctorId" TEXT NOT NULL,
    "specialty" TEXT NOT NULL,
    "primary" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DoctorSpecialty_pkey" PRIMARY KEY ("doctorId","specialty")
);

-- CreateTable
CREATE TABLE "DoctorStaffLink" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "status" "DoctorStaffLinkStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DoctorStaffLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PracticeLocation" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "kind" "PracticeLocationKind" NOT NULL,
    "facilityId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "feeMinor" INTEGER,
    "modes" "ConsultMode"[],
    "addressLine" TEXT,
    "pincode" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PracticeLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctorVerificationCase" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "status" "DoctorVerificationCaseStatus" NOT NULL DEFAULT 'OPEN',
    "documentRefs" TEXT[],
    "dueAt" TIMESTAMP(3) NOT NULL,
    "reviewerUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "reasonCode" TEXT,
    "confirmedRegistrationYear" INTEGER,
    "documentsPurgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DoctorVerificationCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SymptomSpecialtyMap" (
    "id" TEXT NOT NULL,
    "symptomCode" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "specialty" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL,
    "reviewStatus" TEXT NOT NULL DEFAULT 'PENDING_CLINICAL_ADVISOR',
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SymptomSpecialtyMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoctorNextSlot" (
    "practiceLocationId" TEXT NOT NULL,
    "nextSlotAt" TIMESTAMP(3),
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoctorNextSlot_pkey" PRIMARY KEY ("practiceLocationId")
);

-- CreateTable
CREATE TABLE "DirectoryBooking" (
    "id" TEXT NOT NULL,
    "appointmentId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "practiceLocationId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "mode" "ConsultMode" NOT NULL,
    "shareId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DirectoryBooking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DoctorProfile_userId_key" ON "DoctorProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DoctorProfile_hprId_key" ON "DoctorProfile"("hprId");

-- CreateIndex
CREATE INDEX "DoctorProfile_verificationStatus_listed_idx" ON "DoctorProfile"("verificationStatus", "listed");

-- CreateIndex
CREATE UNIQUE INDEX "DoctorProfile_stateCouncil_registrationNumber_key" ON "DoctorProfile"("stateCouncil", "registrationNumber");

-- CreateIndex
CREATE INDEX "DoctorQualification_doctorId_idx" ON "DoctorQualification"("doctorId");

-- CreateIndex
CREATE INDEX "DoctorSpecialty_specialty_idx" ON "DoctorSpecialty"("specialty");

-- CreateIndex
CREATE UNIQUE INDEX "DoctorStaffLink_staffId_key" ON "DoctorStaffLink"("staffId");

-- CreateIndex
CREATE INDEX "DoctorStaffLink_doctorId_status_idx" ON "DoctorStaffLink"("doctorId", "status");

-- CreateIndex
CREATE INDEX "DoctorStaffLink_facilityId_status_idx" ON "DoctorStaffLink"("facilityId", "status");

-- CreateIndex
CREATE INDEX "PracticeLocation_facilityId_idx" ON "PracticeLocation"("facilityId");

-- CreateIndex
CREATE INDEX "PracticeLocation_active_idx" ON "PracticeLocation"("active");

-- CreateIndex
CREATE UNIQUE INDEX "PracticeLocation_doctorId_facilityId_key" ON "PracticeLocation"("doctorId", "facilityId");

-- CreateIndex
CREATE INDEX "DoctorVerificationCase_status_dueAt_idx" ON "DoctorVerificationCase"("status", "dueAt");

-- CreateIndex
CREATE INDEX "DoctorVerificationCase_doctorId_idx" ON "DoctorVerificationCase"("doctorId");

-- CreateIndex
CREATE INDEX "SymptomSpecialtyMap_symptomCode_idx" ON "SymptomSpecialtyMap"("symptomCode");

-- CreateIndex
CREATE UNIQUE INDEX "SymptomSpecialtyMap_version_symptomCode_specialty_key" ON "SymptomSpecialtyMap"("version", "symptomCode", "specialty");

-- CreateIndex
CREATE UNIQUE INDEX "DirectoryBooking_appointmentId_key" ON "DirectoryBooking"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "DirectoryBooking_shareId_key" ON "DirectoryBooking"("shareId");

-- CreateIndex
CREATE INDEX "DirectoryBooking_personId_idx" ON "DirectoryBooking"("personId");

-- CreateIndex
CREATE INDEX "DirectoryBooking_doctorId_idx" ON "DirectoryBooking"("doctorId");

-- AddForeignKey
ALTER TABLE "DoctorQualification" ADD CONSTRAINT "DoctorQualification_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "DoctorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorSpecialty" ADD CONSTRAINT "DoctorSpecialty_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "DoctorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorStaffLink" ADD CONSTRAINT "DoctorStaffLink_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "DoctorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PracticeLocation" ADD CONSTRAINT "PracticeLocation_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "DoctorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorVerificationCase" ADD CONSTRAINT "DoctorVerificationCase_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "DoctorProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorNextSlot" ADD CONSTRAINT "DoctorNextSlot_practiceLocationId_fkey" FOREIGN KEY ("practiceLocationId") REFERENCES "PracticeLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A hospital location never carries a fee of its own (the hospital's tariff applies).
ALTER TABLE "PracticeLocation" ADD CONSTRAINT "PracticeLocation_fee_check" CHECK ("feeMinor" IS NULL OR "kind" = 'CLINIC');
ALTER TABLE "PracticeLocation" ADD CONSTRAINT "PracticeLocation_modes_check" CHECK (cardinality("modes") >= 1);
-- A booking share's window opens before it closes.
ALTER TABLE "RecordShare" ADD CONSTRAINT "RecordShare_valid_window_check" CHECK ("validFrom" IS NULL OR "validFrom" < "expiresAt");
