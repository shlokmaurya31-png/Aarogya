-- D3: Problem and Diagnosis stay separate models. A diagnosis can be added to
-- the problem list (Diagnosis.problemId), and both carry the same code field:
-- codeSystem + code + codeDisplay.

ALTER TABLE "Diagnosis" ADD COLUMN "codeDisplay" TEXT, ADD COLUMN "problemId" TEXT;
ALTER TABLE "Problem" ADD COLUMN "codeSystem" TEXT, ADD COLUMN "code" TEXT, ADD COLUMN "codeDisplay" TEXT;
CREATE INDEX "Diagnosis_problemId_idx" ON "Diagnosis"("problemId");
ALTER TABLE "Diagnosis" ADD CONSTRAINT "Diagnosis_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "Problem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Blank codes are no code.
UPDATE "Diagnosis" SET "codeSystem" = NULLIF(trim("codeSystem"), ''), "code" = NULLIF(trim("code"), '');
-- A code without its system (or the reverse) can't be interpreted; keep the
-- text and drop the half code rather than refuse the migration.
UPDATE "Diagnosis" SET "codeSystem" = NULL, "code" = NULL WHERE ("codeSystem" IS NULL) <> ("code" IS NULL);

ALTER TABLE "Diagnosis" ADD CONSTRAINT "Diagnosis_code_complete" CHECK (("codeSystem" IS NULL) = ("code" IS NULL) AND ("codeDisplay" IS NULL OR "code" IS NOT NULL));
ALTER TABLE "Problem" ADD CONSTRAINT "Problem_code_complete" CHECK (("codeSystem" IS NULL) = ("code" IS NULL) AND ("codeDisplay" IS NULL OR "code" IS NOT NULL));

-- Backfill the link conservatively: a diagnosis whose text matches exactly one
-- problem of the same patient (case and surrounding space ignored).
UPDATE "Diagnosis" d SET "problemId" = m."problemId"
FROM (
  SELECT d2."id" AS "diagnosisId", min(p."id") AS "problemId"
  FROM "Diagnosis" d2
  JOIN "Problem" p ON p."patientId" = d2."patientId" AND lower(trim(p."diagnosis")) = lower(trim(d2."diagnosis"))
  GROUP BY d2."id"
  HAVING count(*) = 1
) m
WHERE d."id" = m."diagnosisId";
