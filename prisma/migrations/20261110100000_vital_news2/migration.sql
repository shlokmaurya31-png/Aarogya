-- Flagship 5a: NEWS2 scored on the server for vitals synced from the ward tablet (display only, pending clinical sign-off). Additive: nullable columns and a new enum.

-- CreateEnum
CREATE TYPE "News2Status" AS ENUM ('PENDING_CLINICAL_SIGN_OFF');

-- AlterTable
ALTER TABLE "Vital" ADD COLUMN     "news2Parameters" INTEGER,
ADD COLUMN     "news2Red" BOOLEAN,
ADD COLUMN     "news2Score" INTEGER,
ADD COLUMN     "news2Status" "News2Status";

