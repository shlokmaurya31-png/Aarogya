-- §8 follow-up: the 11 status-like text columns the re-grep found become
-- enums, using standard value sets (FHIR Condition / AllergyIntolerance,
-- AVPU). Same rule as §8: refuse, don't guess. Each column is checked against
-- the values the code documents; anything else stops the migration and is
-- named. Only documented spellings are mapped (lowercase -> uppercase,
-- "NA" -> NOT_APPLICABLE, Problem "suspected" -> ACTIVE + PROVISIONAL, which is
-- how FHIR represents a suspected condition).

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(DISTINCT "severity", ', ') INTO bad FROM "Allergy" WHERE lower("severity") NOT IN ('mild', 'moderate', 'severe');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Allergy.severity holds values outside MILD/MODERATE/SEVERE: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT "severity", ', ') INTO bad FROM "Problem" WHERE "severity" IS NOT NULL AND lower("severity") NOT IN ('mild', 'moderate', 'severe');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Problem.severity holds values outside MILD/MODERATE/SEVERE: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT "status", ', ') INTO bad FROM "Problem" WHERE lower("status") NOT IN ('active', 'resolved', 'suspected', 'recurrence', 'relapse', 'inactive', 'remission');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Problem.status holds values with no FHIR clinical status: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT "calibrationStatus", ', ') INTO bad FROM "BiomedicalEquipment" WHERE "calibrationStatus" NOT IN ('CALIBRATED', 'DUE', 'OVERDUE');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'BiomedicalEquipment.calibrationStatus holds values outside CALIBRATED/DUE/OVERDUE: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT "referralUrgency", ', ') INTO bad FROM "Encounter" WHERE "referralUrgency" NOT IN ('ROUTINE', 'URGENT', 'STAT');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Encounter.referralUrgency holds values outside ROUTINE/URGENT/STAT: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT "status", ', ') INTO bad FROM "PharmacyStorageCheck" WHERE "status" NOT IN ('OK', 'EXCURSION');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'PharmacyStorageCheck.status holds values outside OK/EXCURSION: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT v, ', ') INTO bad FROM (SELECT "fromStatus" v FROM "QualityIncidentTransition" UNION SELECT "toStatus" FROM "QualityIncidentTransition") t
    WHERE v::text NOT IN ('REPORTED', 'TRIAGED', 'UNDER_INVESTIGATION', 'ACTION_REQUIRED', 'RESOLVED', 'CLOSED', 'CANCELLED');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'QualityIncidentTransition holds statuses outside QualityIncidentStatus: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT "consentStatus", ', ') INTO bad FROM "Surgery" WHERE "consentStatus" NOT IN ('PENDING', 'OBTAINED', 'REFUSED', 'NA', 'NOT_APPLICABLE');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Surgery.consentStatus holds values outside PENDING/OBTAINED/REFUSED/NOT_APPLICABLE: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT "mentalStatus", ', ') INTO bad FROM "TriageAssessment" WHERE "mentalStatus" NOT IN ('ALERT', 'VOICE', 'PAIN', 'UNRESPONSIVE');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'TriageAssessment.mentalStatus holds values that are not AVPU (free text?): %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT "pregnancyStatus", ', ') INTO bad FROM "TriageAssessment" WHERE "pregnancyStatus" NOT IN ('NOT_PREGNANT', 'PREGNANT', 'UNKNOWN', 'NOT_APPLICABLE');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'TriageAssessment.pregnancyStatus holds values outside NOT_PREGNANT/PREGNANT/UNKNOWN/NOT_APPLICABLE: %; resolve before migrating', bad; END IF;
END $$;

CREATE TYPE "Severity" AS ENUM ('MILD', 'MODERATE', 'SEVERE');
CREATE TYPE "AllergyCriticality" AS ENUM ('LOW', 'HIGH', 'UNABLE_TO_ASSESS');
CREATE TYPE "ProblemClinicalStatus" AS ENUM ('ACTIVE', 'RECURRENCE', 'RELAPSE', 'INACTIVE', 'REMISSION', 'RESOLVED');
CREATE TYPE "ProblemVerificationStatus" AS ENUM ('UNCONFIRMED', 'PROVISIONAL', 'DIFFERENTIAL', 'CONFIRMED', 'REFUTED', 'ENTERED_IN_ERROR');
CREATE TYPE "CalibrationStatus" AS ENUM ('CALIBRATED', 'DUE', 'OVERDUE');
CREATE TYPE "StorageCheckStatus" AS ENUM ('OK', 'EXCURSION');
CREATE TYPE "SurgeryConsentStatus" AS ENUM ('PENDING', 'OBTAINED', 'REFUSED', 'NOT_APPLICABLE');
CREATE TYPE "AvpuScale" AS ENUM ('ALERT', 'VOICE', 'PAIN', 'UNRESPONSIVE');
CREATE TYPE "PregnancyStatus" AS ENUM ('NOT_PREGNANT', 'PREGNANT', 'UNKNOWN', 'NOT_APPLICABLE');

ALTER TABLE "Allergy" ALTER COLUMN "severity" TYPE "Severity" USING upper("severity")::"Severity";
ALTER TABLE "Allergy" ADD COLUMN "criticality" "AllergyCriticality";

-- Problem: "suspected" is an ACTIVE problem whose verification is PROVISIONAL.
-- Other rows' verification was never recorded, so it stays NULL (not guessed).
ALTER TABLE "Problem" ADD COLUMN "verificationStatus" "ProblemVerificationStatus";
UPDATE "Problem" SET "verificationStatus" = 'PROVISIONAL' WHERE lower("status") = 'suspected';
ALTER TABLE "Problem" ALTER COLUMN "status" TYPE "ProblemClinicalStatus"
  USING (CASE lower("status") WHEN 'suspected' THEN 'ACTIVE' ELSE upper("status") END)::"ProblemClinicalStatus";
ALTER TABLE "Problem" ALTER COLUMN "severity" TYPE "Severity" USING upper("severity")::"Severity";

ALTER TABLE "BiomedicalEquipment" ALTER COLUMN "calibrationStatus" TYPE "CalibrationStatus" USING "calibrationStatus"::"CalibrationStatus";
ALTER TABLE "Encounter" ALTER COLUMN "referralUrgency" TYPE "Priority" USING "referralUrgency"::"Priority";
ALTER TABLE "PharmacyStorageCheck" ALTER COLUMN "status" TYPE "StorageCheckStatus" USING "status"::"StorageCheckStatus";
ALTER TABLE "QualityIncidentTransition"
  ALTER COLUMN "fromStatus" TYPE "QualityIncidentStatus" USING "fromStatus"::text::"QualityIncidentStatus",
  ALTER COLUMN "toStatus" TYPE "QualityIncidentStatus" USING "toStatus"::text::"QualityIncidentStatus";
ALTER TABLE "Surgery" ALTER COLUMN "consentStatus" TYPE "SurgeryConsentStatus"
  USING (CASE "consentStatus" WHEN 'NA' THEN 'NOT_APPLICABLE' ELSE "consentStatus" END)::"SurgeryConsentStatus";
ALTER TABLE "TriageAssessment"
  ALTER COLUMN "mentalStatus" TYPE "AvpuScale" USING "mentalStatus"::"AvpuScale",
  ALTER COLUMN "pregnancyStatus" TYPE "PregnancyStatus" USING "pregnancyStatus"::"PregnancyStatus";
