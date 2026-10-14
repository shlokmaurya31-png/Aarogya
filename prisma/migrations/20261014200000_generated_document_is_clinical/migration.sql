-- D4: a generated PDF is also a ClinicalDocument (created in the same
-- transaction from now on, src/lib/documents/service.ts), so it appears in the
-- portal and the Hospital OS document list. GeneratedDocument keeps render,
-- hash and verify-token metadata; the patient and author move to the
-- ClinicalDocument.

ALTER TABLE "ClinicalDocument" ADD COLUMN "generatedDocumentId" TEXT;
CREATE UNIQUE INDEX "ClinicalDocument_generatedDocumentId_key" ON "ClinicalDocument"("generatedDocumentId");
ALTER TABLE "ClinicalDocument" ADD CONSTRAINT "ClinicalDocument_generatedDocumentId_fkey" FOREIGN KEY ("generatedDocumentId") REFERENCES "GeneratedDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one source: a staff upload, a patient upload, or a generated document.
ALTER TABLE "ClinicalDocument" DROP CONSTRAINT "ClinicalDocument_one_uploader";
ALTER TABLE "ClinicalDocument" ADD CONSTRAINT "ClinicalDocument_one_source" CHECK (
  num_nonnulls("uploadedByStaffId", "uploadedByUserId", "generatedDocumentId") = 1
);

-- Backfill: every generated document that names an existing patient. The
-- mapping matches clinicalDocumentFieldsFor in src/lib/documents/service.ts.
INSERT INTO "ClinicalDocument" (
  "id", "facilityId", "patientId", "type", "title", "storageRef", "sha256", "version", "status", "accessPolicy",
  "authorStaffId", "generatedDocumentId", "createdAt"
)
SELECT
  'gen-' || md5(g."id"), g."facilityId", g."patientId",
  upper(replace(g."type", '-', '_')), g."title", g."storageRef", g."sha256", 1,
  CASE WHEN g."isDraft" THEN 'DRAFT' ELSE 'CURRENT' END,
  CASE WHEN g."type" = 'claim-packet' THEN 'CLINICAL_STAFF' ELSE 'PATIENT_VISIBLE' END,
  (SELECT s."id" FROM "HospitalStaffProfile" s WHERE s."userId" = g."issuedByUserId"),
  g."id", g."createdAt"
FROM "GeneratedDocument" g
JOIN "Patient" p ON p."id" = g."patientId";

DROP INDEX "GeneratedDocument_facilityId_patientId_idx";
ALTER TABLE "GeneratedDocument" DROP COLUMN "issuedByUserId", DROP COLUMN "patientId";
