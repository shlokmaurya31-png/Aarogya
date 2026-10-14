-- CreateEnum
CREATE TYPE "PatientLinkStatus" AS ENUM ('OTP_SENT', 'FRONT_DESK_REVIEW', 'LINKED', 'CREATED_NEW', 'REJECTED');

-- CreateTable
CREATE TABLE "PatientLinkRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "candidatePatientId" TEXT,
    "status" "PatientLinkStatus" NOT NULL,
    "matchConfidence" TEXT NOT NULL,
    "matchScore" INTEGER NOT NULL,
    "matchedOn" TEXT[],
    "claimedName" TEXT NOT NULL,
    "claimedPhone" TEXT,
    "claimedDob" TIMESTAMP(3),
    "claimedSex" TEXT NOT NULL,
    "otpHash" TEXT,
    "otpExpiresAt" TIMESTAMP(3),
    "otpAttempts" INTEGER NOT NULL DEFAULT 0,
    "reviewReason" TEXT,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientLinkRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PatientLinkRequest_facilityId_status_idx" ON "PatientLinkRequest"("facilityId", "status");

-- CreateIndex
CREATE INDEX "PatientLinkRequest_userId_idx" ON "PatientLinkRequest"("userId");

-- AddForeignKey
ALTER TABLE "PatientLinkRequest" ADD CONSTRAINT "PatientLinkRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientLinkRequest" ADD CONSTRAINT "PatientLinkRequest_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PatientLinkRequest" ADD CONSTRAINT "PatientLinkRequest_candidatePatientId_fkey" FOREIGN KEY ("candidatePatientId") REFERENCES "Patient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

