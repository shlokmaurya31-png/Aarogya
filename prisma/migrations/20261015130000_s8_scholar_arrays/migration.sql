-- Section 8 schema clean-up, scholar domain (docs/POSTGRES_CUTOVER_REPORT.md §8).
-- Every conversion is guarded: if any existing row holds a value outside the
-- target set, the migration stops and names the values instead of guessing.

DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad FROM "StudentProfile" t
  WHERE t."clinicalInterests" IS NOT NULL AND (
    t."clinicalInterests" !~ '^\s*\[' OR NOT pg_input_is_valid(t."clinicalInterests", 'jsonb')
    OR jsonb_typeof(t."clinicalInterests"::jsonb) <> 'array'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(t."clinicalInterests"::jsonb) el WHERE jsonb_typeof(el) <> 'string'));
  IF bad > 0 THEN RAISE EXCEPTION 'StudentProfile.clinicalInterests: % row(s) are not a JSON array of strings; resolve before migrating', bad; END IF;
END $$;
ALTER TABLE "StudentProfile" ADD COLUMN "clinicalInterests__arr" TEXT[];
UPDATE "StudentProfile" SET "clinicalInterests__arr" = COALESCE((SELECT array_agg(v ORDER BY o) FROM jsonb_array_elements_text("clinicalInterests"::jsonb) WITH ORDINALITY AS a(v, o)), '{}') WHERE "clinicalInterests" IS NOT NULL;
UPDATE "StudentProfile" SET "clinicalInterests__arr" = '{}' WHERE "clinicalInterests__arr" IS NULL;
ALTER TABLE "StudentProfile" DROP COLUMN "clinicalInterests";
ALTER TABLE "StudentProfile" RENAME COLUMN "clinicalInterests__arr" TO "clinicalInterests";
ALTER TABLE "StudentProfile" ALTER COLUMN "clinicalInterests" SET NOT NULL;
DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad FROM "ClinicalCase" t
  WHERE t."learningObjectives" IS NOT NULL AND (
    t."learningObjectives" !~ '^\s*\[' OR NOT pg_input_is_valid(t."learningObjectives", 'jsonb')
    OR jsonb_typeof(t."learningObjectives"::jsonb) <> 'array'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(t."learningObjectives"::jsonb) el WHERE jsonb_typeof(el) <> 'string'));
  IF bad > 0 THEN RAISE EXCEPTION 'ClinicalCase.learningObjectives: % row(s) are not a JSON array of strings; resolve before migrating', bad; END IF;
END $$;
ALTER TABLE "ClinicalCase" ADD COLUMN "learningObjectives__arr" TEXT[];
UPDATE "ClinicalCase" SET "learningObjectives__arr" = COALESCE((SELECT array_agg(v ORDER BY o) FROM jsonb_array_elements_text("learningObjectives"::jsonb) WITH ORDINALITY AS a(v, o)), '{}') WHERE "learningObjectives" IS NOT NULL;
UPDATE "ClinicalCase" SET "learningObjectives__arr" = '{}' WHERE "learningObjectives__arr" IS NULL;
ALTER TABLE "ClinicalCase" DROP COLUMN "learningObjectives";
ALTER TABLE "ClinicalCase" RENAME COLUMN "learningObjectives__arr" TO "learningObjectives";
ALTER TABLE "ClinicalCase" ALTER COLUMN "learningObjectives" SET NOT NULL;
DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad FROM "NotebookEntry" t
  WHERE t."tags" IS NOT NULL AND (
    t."tags" !~ '^\s*\[' OR NOT pg_input_is_valid(t."tags", 'jsonb')
    OR jsonb_typeof(t."tags"::jsonb) <> 'array'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(t."tags"::jsonb) el WHERE jsonb_typeof(el) <> 'string'));
  IF bad > 0 THEN RAISE EXCEPTION 'NotebookEntry.tags: % row(s) are not a JSON array of strings; resolve before migrating', bad; END IF;
END $$;
ALTER TABLE "NotebookEntry" ADD COLUMN "tags__arr" TEXT[];
UPDATE "NotebookEntry" SET "tags__arr" = COALESCE((SELECT array_agg(v ORDER BY o) FROM jsonb_array_elements_text("tags"::jsonb) WITH ORDINALITY AS a(v, o)), '{}') WHERE "tags" IS NOT NULL;
UPDATE "NotebookEntry" SET "tags__arr" = '{}' WHERE "tags__arr" IS NULL;
ALTER TABLE "NotebookEntry" DROP COLUMN "tags";
ALTER TABLE "NotebookEntry" RENAME COLUMN "tags__arr" TO "tags";
ALTER TABLE "NotebookEntry" ALTER COLUMN "tags" SET NOT NULL;
DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad FROM "LearningRecommendation" t
  WHERE t."caseIds" IS NOT NULL AND (
    t."caseIds" !~ '^\s*\[' OR NOT pg_input_is_valid(t."caseIds", 'jsonb')
    OR jsonb_typeof(t."caseIds"::jsonb) <> 'array'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(t."caseIds"::jsonb) el WHERE jsonb_typeof(el) <> 'string'));
  IF bad > 0 THEN RAISE EXCEPTION 'LearningRecommendation.caseIds: % row(s) are not a JSON array of strings; resolve before migrating', bad; END IF;
END $$;
ALTER TABLE "LearningRecommendation" ADD COLUMN "caseIds__arr" TEXT[];
UPDATE "LearningRecommendation" SET "caseIds__arr" = COALESCE((SELECT array_agg(v ORDER BY o) FROM jsonb_array_elements_text("caseIds"::jsonb) WITH ORDINALITY AS a(v, o)), '{}') WHERE "caseIds" IS NOT NULL;
UPDATE "LearningRecommendation" SET "caseIds__arr" = '{}' WHERE "caseIds__arr" IS NULL;
ALTER TABLE "LearningRecommendation" DROP COLUMN "caseIds";
ALTER TABLE "LearningRecommendation" RENAME COLUMN "caseIds__arr" TO "caseIds";
ALTER TABLE "LearningRecommendation" ALTER COLUMN "caseIds" SET NOT NULL;
DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad FROM "ClinicalCase" t
  WHERE t."learnerTracks" IS NOT NULL AND (
    t."learnerTracks" !~ '^\s*\[' OR NOT pg_input_is_valid(t."learnerTracks", 'jsonb')
    OR jsonb_typeof(t."learnerTracks"::jsonb) <> 'array'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(t."learnerTracks"::jsonb) el WHERE jsonb_typeof(el) <> 'string'));
  IF bad > 0 THEN RAISE EXCEPTION 'ClinicalCase.learnerTracks: % row(s) are not a JSON array of strings; resolve before migrating', bad; END IF;
END $$;
ALTER TABLE "ClinicalCase" ADD COLUMN "learnerTracks__arr" TEXT[];
UPDATE "ClinicalCase" SET "learnerTracks__arr" = COALESCE((SELECT array_agg(v ORDER BY o) FROM jsonb_array_elements_text("learnerTracks"::jsonb) WITH ORDINALITY AS a(v, o)), '{}') WHERE "learnerTracks" IS NOT NULL;
UPDATE "ClinicalCase" SET "learnerTracks__arr" = '{}' WHERE "learnerTracks__arr" IS NULL;
ALTER TABLE "ClinicalCase" DROP COLUMN "learnerTracks";
ALTER TABLE "ClinicalCase" RENAME COLUMN "learnerTracks__arr" TO "learnerTracks";
ALTER TABLE "ClinicalCase" ALTER COLUMN "learnerTracks" SET NOT NULL;
DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad FROM "ClinicalCase" WHERE NOT ("learnerTracks" <@ ARRAY['MEDICINE', 'NURSING', 'PHARMACY', 'DIAGNOSTICS', 'PHYSIOTHERAPY', 'PUBLIC_HEALTH']::TEXT[]);
  IF bad > 0 THEN RAISE EXCEPTION 'ClinicalCase.learnerTracks: % row(s) hold a value that is not a LearningTrack; resolve before migrating', bad; END IF;
END $$;
ALTER TABLE "ClinicalCase" ADD CONSTRAINT "ClinicalCase_learnerTracks_check" CHECK ("learnerTracks" <@ ARRAY['MEDICINE', 'NURSING', 'PHARMACY', 'DIAGNOSTICS', 'PHYSIOTHERAPY', 'PUBLIC_HEALTH']::TEXT[]);
