-- Flagship 4a: offline nursing, phase 2 (vitals, intake/output, nursing tasks
-- and PRN doses). Additive: new enum values, nullable columns, PRN limits
-- (null for every existing order: no limits, so no PRN offline), and two NOT
-- NULLs relaxed (DOSE_* commands and their conflicts still carry the dose).

ALTER TYPE "OfflineCommandKind" ADD VALUE 'VITALS';
ALTER TYPE "OfflineCommandKind" ADD VALUE 'INTAKE_OUTPUT';
ALTER TYPE "OfflineCommandKind" ADD VALUE 'TASK_COMPLETED';
ALTER TYPE "OfflineCommandKind" ADD VALUE 'PRN_GIVEN';
ALTER TYPE "OfflineCommandKind" ADD VALUE 'PRN_BREACH_REFUSED';

ALTER TYPE "OfflineRefusalReason" ADD VALUE 'NOT_ASSIGNED';
ALTER TYPE "OfflineRefusalReason" ADD VALUE 'PRN_NOT_OFFLINE';
ALTER TYPE "OfflineRefusalReason" ADD VALUE 'INVALID_VALUES';
ALTER TYPE "OfflineRefusalReason" ADD VALUE 'UNKNOWN_TASK';
ALTER TYPE "OfflineRefusalReason" ADD VALUE 'UNKNOWN_ENCOUNTER';

ALTER TYPE "OfflineConflictKind" ADD VALUE 'PRN_LIMIT_BREACHED';
ALTER TYPE "OfflineConflictKind" ADD VALUE 'PRN_BREACH_ATTEMPT';
ALTER TYPE "OfflineConflictKind" ADD VALUE 'REFUSED_RECORD';

-- PRN limits: both or neither, positive; "offline allowed" only for a PRN order with both.
ALTER TABLE "MedicationOrder" ADD COLUMN     "prnMaxDosesPer24h" INTEGER,
ADD COLUMN     "prnMinIntervalMinutes" INTEGER,
ADD COLUMN     "prnOfflineAllowed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MedicationOrder" ADD CONSTRAINT "MedicationOrder_prn_limits"
  CHECK ((("prnMinIntervalMinutes" IS NULL) = ("prnMaxDosesPer24h" IS NULL))
     AND ("prnMinIntervalMinutes" IS NULL OR "prnMinIntervalMinutes" > 0)
     AND ("prnMaxDosesPer24h" IS NULL OR "prnMaxDosesPer24h" > 0)
     AND (NOT "prnOfflineAllowed" OR ("prn" AND "prnMinIntervalMinutes" IS NOT NULL)));

ALTER TABLE "OfflineCommand" ADD COLUMN     "encounterId" TEXT,
ADD COLUMN     "medicationOrderId" TEXT,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "payload" JSONB,
ADD COLUMN     "taskId" TEXT,
ALTER COLUMN "administrationId" DROP NOT NULL;
-- A dose command names its dose.
ALTER TABLE "OfflineCommand" ADD CONSTRAINT "OfflineCommand_dose_named"
  CHECK ("kind" NOT IN ('DOSE_GIVEN', 'DOSE_HELD', 'DOSE_REFUSED') OR "administrationId" IS NOT NULL);

ALTER TABLE "OfflineConflict" ADD COLUMN     "patientId" TEXT,
ALTER COLUMN "administrationId" DROP NOT NULL;
