-- Week 4a, step h: a patient-reported allergy may arrive without a severity.
-- The bridge never guesses one; a clinician's allergy still always has one.
-- Additive: no existing row changes (every existing allergy has a severity).

-- AlterTable
ALTER TABLE "Allergy" ALTER COLUMN "severity" DROP NOT NULL;

-- Only a patient-provided allergy may lack a severity.
ALTER TABLE "Allergy" ADD CONSTRAINT "Allergy_severity_required_check" CHECK ("severity" IS NOT NULL OR "source" = 'PATIENT_PROVIDED');
