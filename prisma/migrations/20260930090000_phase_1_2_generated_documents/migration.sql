-- Phase 1.2 — Generated documents + authenticity verification (PostgreSQL).
-- Mirrors prisma/migrations/20260930090000_phase_1_2_generated_documents.
--
-- Strictly additive: one new table (GeneratedDocument) recording every
-- server-rendered PDF and its public verifyToken. No DROP, no retype, no enum,
-- no data change. type is TEXT (DocumentType enforced in code), per convention.

-- CreateTable
CREATE TABLE "GeneratedDocument" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "storageRef" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "verifyToken" TEXT NOT NULL,
    "issuedByUserId" TEXT,
    "issuedByName" TEXT,
    "authorRegistration" TEXT,
    "patientId" TEXT,
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeneratedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedDocument_verifyToken_key" ON "GeneratedDocument"("verifyToken");
CREATE INDEX "GeneratedDocument_facilityId_type_idx" ON "GeneratedDocument"("facilityId", "type");
CREATE INDEX "GeneratedDocument_facilityId_patientId_idx" ON "GeneratedDocument"("facilityId", "patientId");

-- AddForeignKey
ALTER TABLE "GeneratedDocument" ADD CONSTRAINT "GeneratedDocument_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
