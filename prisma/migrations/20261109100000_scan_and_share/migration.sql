-- Flagship 6: Scan and Share check-in (mock ABDM gateway). Additive: new tables.
-- No Aadhaar column exists or is added; the ABHA number is a hash and its last 4.

-- CreateEnum
CREATE TYPE "ScanShareStatus" AS ENUM ('WAITING', 'QUEUED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ScanShareCounter" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "departmentId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanShareCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanShareCheckIn" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "counterId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "gateway" TEXT NOT NULL,
    "abhaAddress" TEXT NOT NULL,
    "abhaNumberHash" TEXT,
    "abhaNumberLast4" TEXT,
    "name" TEXT NOT NULL,
    "sex" TEXT NOT NULL,
    "yearOfBirth" INTEGER,
    "dob" TIMESTAMP(3),
    "phone" TEXT,
    "status" "ScanShareStatus" NOT NULL DEFAULT 'WAITING',
    "token" TEXT NOT NULL,
    "tokenDay" TEXT NOT NULL,
    "patientId" TEXT,
    "queueEntryId" TEXT,
    "queuedAt" TIMESTAMP(3),
    "queuedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanShareCheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScanShareCounter_facilityId_code_key" ON "ScanShareCounter"("facilityId", "code");

-- CreateIndex
CREATE INDEX "ScanShareCheckIn_facilityId_tokenDay_idx" ON "ScanShareCheckIn"("facilityId", "tokenDay");

-- CreateIndex
CREATE UNIQUE INDEX "ScanShareCheckIn_facilityId_requestId_key" ON "ScanShareCheckIn"("facilityId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "ScanShareCheckIn_facilityId_tokenDay_token_key" ON "ScanShareCheckIn"("facilityId", "tokenDay", "token");

-- AddForeignKey
ALTER TABLE "ScanShareCheckIn" ADD CONSTRAINT "ScanShareCheckIn_counterId_fkey" FOREIGN KEY ("counterId") REFERENCES "ScanShareCounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

