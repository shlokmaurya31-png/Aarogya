-- Week 4a, step c: the document pipeline's models (person-scoped) and the
-- facility-side conflict and allergy notice. Additive. Allergy.source defaults
-- to CLINICIAN for every existing row: clinicians were the only way an allergy
-- could be recorded before this migration, so that is the recorded fact, not a
-- guess.

CREATE TYPE "AllergySource" AS ENUM ('CLINICIAN', 'PATIENT_PROVIDED');
CREATE TYPE "DocumentProcessingStatus" AS ENUM ('QUEUED', 'RUNNING', 'AWAITING_REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED', 'SKIPPED');
CREATE TYPE "DocumentStepKind" AS ENUM ('PAGE_SPLIT', 'OCR', 'TRANSLATE', 'EXTRACT', 'MERGE');
CREATE TYPE "DocumentStepStatus" AS ENUM ('PENDING', 'RUNNING', 'DONE', 'SKIPPED', 'FAILED');
CREATE TYPE "DocumentStepError" AS ENUM ('PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'UNREADABLE', 'UNSUPPORTED_LANGUAGE', 'EXACT_COPY_VIOLATION', 'TOO_LARGE', 'INTERNAL', 'REAL_DATA_DISABLED', 'CONSENT_REQUIRED');
CREATE TYPE "ExactCopyCheck" AS ENUM ('PASSED', 'FAILED');
CREATE TYPE "ExtractedFactType" AS ENUM ('DOCUMENT_META', 'DIAGNOSIS', 'MEDICATION', 'LAB_VALUE', 'PROCEDURE', 'ALLERGY');
CREATE TYPE "ConfidenceBand" AS ENUM ('HIGH', 'MEDIUM', 'LOW');
CREATE TYPE "FactReviewStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CORRECTED', 'REJECTED');
CREATE TYPE "ReviewedVia" AS ENUM ('SELF', 'PROXY');
CREATE TYPE "PatientProvidedKind" AS ENUM ('DIAGNOSIS', 'MEDICATION_HISTORY', 'LAB_RESULT', 'PROCEDURE', 'ALLERGY');
CREATE TYPE "PatientProvidedStatus" AS ENUM ('ACTIVE', 'WITHDRAWN', 'SUPERSEDED');
CREATE TYPE "RecordConflictStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED_BY_CLINICIAN');
CREATE TYPE "PatientAllergyNoticeKind" AS ENUM ('WITHDRAWN_BY_PATIENT');
ALTER TABLE "Allergy" ADD COLUMN     "patientProvidedRecordId" TEXT,
ADD COLUMN     "source" "AllergySource" NOT NULL DEFAULT 'CLINICIAN';
CREATE TABLE "DocumentProcessing" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "run" INTEGER NOT NULL DEFAULT 1,
    "status" "DocumentProcessingStatus" NOT NULL DEFAULT 'QUEUED',
    "skipReason" "DocumentStepError",
    "targetLanguage" TEXT NOT NULL,
    "pageCount" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DocumentProcessing_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "DocumentProcessingStep" (
    "id" TEXT NOT NULL,
    "processingId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "step" "DocumentStepKind" NOT NULL,
    "status" "DocumentStepStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" "DocumentStepError",
    "provider" TEXT,
    "model" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    CONSTRAINT "DocumentProcessingStep_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "DocumentPage" (
    "id" TEXT NOT NULL,
    "processingId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "pageNo" INTEGER NOT NULL,
    "storageRef" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    CONSTRAINT "DocumentPage_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ExtractedText" (
    "id" TEXT NOT NULL,
    "processingId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "pageNo" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "layout" JSONB NOT NULL DEFAULT '[]',
    "language" TEXT NOT NULL,
    "script" TEXT NOT NULL,
    "handwritten" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExtractedText_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Translation" (
    "id" TEXT NOT NULL,
    "extractedTextId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "targetLanguage" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "protectedSpans" JSONB NOT NULL DEFAULT '[]',
    "exactCopyCheck" "ExactCopyCheck" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Translation_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ExtractedFact" (
    "id" TEXT NOT NULL,
    "processingId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "factType" "ExtractedFactType" NOT NULL,
    "value" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "confidenceBand" "ConfidenceBand" NOT NULL,
    "handwritten" BOOLEAN NOT NULL DEFAULT false,
    "pageNo" INTEGER NOT NULL,
    "region" JSONB,
    "sourceText" TEXT NOT NULL,
    "exactCopyCheck" "ExactCopyCheck" NOT NULL,
    "reviewStatus" "FactReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedValue" JSONB,
    "confirmedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedVia" "ReviewedVia",
    "recordEntryId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExtractedFact_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "PatientProvidedRecord" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "kind" "PatientProvidedKind" NOT NULL,
    "value" JSONB NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'PATIENT_PROVIDED',
    "factId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "pageNo" INTEGER NOT NULL,
    "region" JSONB,
    "handwritten" BOOLEAN NOT NULL DEFAULT false,
    "effectiveDate" TIMESTAMP(3),
    "status" "PatientProvidedStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),
    CONSTRAINT "PatientProvidedRecord_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "RecordConflict" (
    "id" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "kind" "PatientProvidedKind" NOT NULL,
    "patientProvidedRecordId" TEXT NOT NULL,
    "verifiedSourceType" TEXT NOT NULL,
    "verifiedSourceId" TEXT NOT NULL,
    "status" "RecordConflictStatus" NOT NULL DEFAULT 'OPEN',
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedByStaffId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    CONSTRAINT "RecordConflict_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "PatientAllergyNotice" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "kind" "PatientAllergyNoticeKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByStaffId" TEXT,
    CONSTRAINT "PatientAllergyNotice_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DocumentProcessing_personId_status_idx" ON "DocumentProcessing"("personId", "status");
CREATE UNIQUE INDEX "DocumentProcessing_documentId_run_key" ON "DocumentProcessing"("documentId", "run");
CREATE INDEX "DocumentProcessingStep_personId_idx" ON "DocumentProcessingStep"("personId");
CREATE UNIQUE INDEX "DocumentProcessingStep_processingId_step_key" ON "DocumentProcessingStep"("processingId", "step");
CREATE INDEX "DocumentPage_personId_idx" ON "DocumentPage"("personId");
CREATE UNIQUE INDEX "DocumentPage_processingId_pageNo_key" ON "DocumentPage"("processingId", "pageNo");
CREATE INDEX "ExtractedText_personId_idx" ON "ExtractedText"("personId");
CREATE UNIQUE INDEX "ExtractedText_processingId_pageNo_key" ON "ExtractedText"("processingId", "pageNo");
CREATE INDEX "Translation_personId_idx" ON "Translation"("personId");
CREATE UNIQUE INDEX "Translation_extractedTextId_targetLanguage_key" ON "Translation"("extractedTextId", "targetLanguage");
CREATE UNIQUE INDEX "ExtractedFact_recordEntryId_key" ON "ExtractedFact"("recordEntryId");
CREATE INDEX "ExtractedFact_personId_reviewStatus_idx" ON "ExtractedFact"("personId", "reviewStatus");
CREATE INDEX "ExtractedFact_processingId_idx" ON "ExtractedFact"("processingId");
CREATE UNIQUE INDEX "PatientProvidedRecord_factId_key" ON "PatientProvidedRecord"("factId");
CREATE INDEX "PatientProvidedRecord_personId_kind_status_idx" ON "PatientProvidedRecord"("personId", "kind", "status");
CREATE INDEX "RecordConflict_facilityId_patientId_status_idx" ON "RecordConflict"("facilityId", "patientId", "status");
CREATE INDEX "RecordConflict_personId_status_idx" ON "RecordConflict"("personId", "status");
CREATE UNIQUE INDEX "RecordConflict_patientProvidedRecordId_verifiedSourceType_v_key" ON "RecordConflict"("patientProvidedRecordId", "verifiedSourceType", "verifiedSourceId");
CREATE INDEX "PatientAllergyNotice_facilityId_patientId_idx" ON "PatientAllergyNotice"("facilityId", "patientId");
ALTER TABLE "DocumentProcessing" ADD CONSTRAINT "DocumentProcessing_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentProcessing" ADD CONSTRAINT "DocumentProcessing_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "PersonDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentProcessingStep" ADD CONSTRAINT "DocumentProcessingStep_processingId_fkey" FOREIGN KEY ("processingId") REFERENCES "DocumentProcessing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DocumentPage" ADD CONSTRAINT "DocumentPage_processingId_fkey" FOREIGN KEY ("processingId") REFERENCES "DocumentProcessing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExtractedText" ADD CONSTRAINT "ExtractedText_processingId_fkey" FOREIGN KEY ("processingId") REFERENCES "DocumentProcessing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Translation" ADD CONSTRAINT "Translation_extractedTextId_fkey" FOREIGN KEY ("extractedTextId") REFERENCES "ExtractedText"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExtractedFact" ADD CONSTRAINT "ExtractedFact_processingId_fkey" FOREIGN KEY ("processingId") REFERENCES "DocumentProcessing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PatientProvidedRecord" ADD CONSTRAINT "PatientProvidedRecord_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Invariants ───────────────────────────────────────────────────────────
-- A patient-provided record says so, always.
ALTER TABLE "PatientProvidedRecord" ADD CONSTRAINT "PatientProvidedRecord_source_check" CHECK ("source" = 'PATIENT_PROVIDED');
ALTER TABLE "PatientProvidedRecord" ADD CONSTRAINT "PatientProvidedRecord_withdrawn_check" CHECK (("status" = 'WITHDRAWN') = ("withdrawnAt" IS NOT NULL));
-- A decided fact says who decided and when; a corrected one carries the correction; only a confirmed or corrected fact becomes a record.
ALTER TABLE "ExtractedFact" ADD CONSTRAINT "ExtractedFact_review_check"
  CHECK (("reviewStatus" = 'PENDING') = ("reviewedAt" IS NULL) AND ("reviewStatus" = 'PENDING') = ("reviewedByUserId" IS NULL)
     AND ("reviewStatus" <> 'CORRECTED' OR "reviewedValue" IS NOT NULL)
     AND ("recordEntryId" IS NULL OR "reviewStatus" IN ('CONFIRMED', 'CORRECTED')));
ALTER TABLE "ExtractedFact" ADD CONSTRAINT "ExtractedFact_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 1);
-- A handwritten fact is decided as confirmed only when every field was confirmed (enforced in the service; the DB keeps the list honest).
ALTER TABLE "ExtractedFact" ADD CONSTRAINT "ExtractedFact_fields_check" CHECK ("handwritten" OR cardinality("confirmedFields") = 0);
-- A patient-provided allergy row points at its record, and only such a row does.
ALTER TABLE "Allergy" ADD CONSTRAINT "Allergy_patient_provided_check"
  CHECK (("source" = 'PATIENT_PROVIDED') = ("patientProvidedRecordId" IS NOT NULL));
CREATE UNIQUE INDEX "Allergy_one_bridge_per_record" ON "Allergy"("patientId", "patientProvidedRecordId") WHERE "patientProvidedRecordId" IS NOT NULL;
-- A run's status and its completion time agree.
ALTER TABLE "DocumentProcessing" ADD CONSTRAINT "DocumentProcessing_completed_check" CHECK (("status" IN ('COMPLETED', 'FAILED', 'CANCELLED', 'SKIPPED')) = ("completedAt" IS NOT NULL));
ALTER TABLE "DocumentProcessing" ADD CONSTRAINT "DocumentProcessing_skip_check" CHECK (("status" = 'SKIPPED') = ("skipReason" IS NOT NULL));
-- At most one run of a document in flight.
CREATE UNIQUE INDEX "DocumentProcessing_one_open_run" ON "DocumentProcessing"("documentId") WHERE "status" IN ('QUEUED', 'RUNNING', 'AWAITING_REVIEW');
