-- Date-of-birth precision as an enum instead of a boolean.
-- dobEstimated = true -> ESTIMATED_FROM_AGE; otherwise DAY.
CREATE TYPE "DobPrecision" AS ENUM ('DAY', 'MONTH', 'YEAR', 'ESTIMATED_FROM_AGE');
ALTER TABLE "Patient" ADD COLUMN "dobPrecision" "DobPrecision" NOT NULL DEFAULT 'DAY';
UPDATE "Patient" SET "dobPrecision" = 'ESTIMATED_FROM_AGE' WHERE "dobEstimated";
ALTER TABLE "Patient" DROP COLUMN "dobEstimated";
