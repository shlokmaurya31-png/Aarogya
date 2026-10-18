-- Phase 0, part 2 (c): person-level documents. Uploads belong to the Person,
-- tied to no facility; staff reach them only through personAccess(). Existing
-- uploads move here through the identity migration (refuse rather than guess),
-- which keeps their bytes where they are and deletes the ClinicalDocument row it
-- moved. Additive.

CREATE TYPE "PersonDocumentStatus" AS ENUM ('CURRENT', 'WITHDRAWN');
CREATE TABLE "PersonDocument" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "storageRef" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "contentType" TEXT,
    "status" "PersonDocumentStatus" NOT NULL DEFAULT 'CURRENT',
    "uploadedByUserId" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "legacyFacilityId" TEXT,
    "legacyPatientId" TEXT,
    "movedFromClinicalDocumentId" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PersonDocument_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PersonDocument_movedFromClinicalDocumentId_key" ON "PersonDocument"("movedFromClinicalDocumentId");
CREATE INDEX "PersonDocument_personId_status_idx" ON "PersonDocument"("personId", "status");
ALTER TABLE "PersonDocument" ADD CONSTRAINT "PersonDocument_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Legacy facility and record go together, and only on moved uploads.
ALTER TABLE "PersonDocument" ADD CONSTRAINT "PersonDocument_legacy_check"
  CHECK (("legacyFacilityId" IS NULL OR "legacyPatientId" IS NOT NULL) AND ("legacyPatientId" IS NULL OR "movedFromClinicalDocumentId" IS NOT NULL));
ALTER TABLE "PersonDocument" ADD CONSTRAINT "PersonDocument_withdrawn_check"
  CHECK (("status" = 'WITHDRAWN') = ("withdrawnAt" IS NOT NULL));
