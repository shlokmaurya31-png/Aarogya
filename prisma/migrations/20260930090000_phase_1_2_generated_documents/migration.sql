-- Phase 1.2 — Generated documents + authenticity verification (SQLite).
-- Strictly additive: one new table (GeneratedDocument) recording every
-- server-rendered PDF and its public verifyToken. No existing table or column
-- is touched. type is TEXT (DocumentType enforced in code), per convention.

-- CreateTable
CREATE TABLE "GeneratedDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GeneratedDocument_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "GeneratedDocument_verifyToken_key" ON "GeneratedDocument"("verifyToken");
CREATE INDEX "GeneratedDocument_facilityId_type_idx" ON "GeneratedDocument"("facilityId", "type");
CREATE INDEX "GeneratedDocument_facilityId_patientId_idx" ON "GeneratedDocument"("facilityId", "patientId");
