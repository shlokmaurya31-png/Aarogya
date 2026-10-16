-- Batch 6, fix 1: manual discharge holds. A hold records who placed it, the
-- reason code and when; a person clears it. While any hold on a discharge is
-- active (clearedAt IS NULL), finalizeDischarge refuses. Additive: no
-- existing rows.

CREATE TYPE "DischargeHoldReason" AS ENUM ('BILLING', 'INSURANCE', 'CLINICAL', 'DOCUMENTATION', 'PHARMACY', 'TRANSPORT', 'PATIENT_REQUEST', 'LEGAL', 'OTHER');

CREATE TABLE "DischargeHold" (
    "id" TEXT NOT NULL,
    "dischargeId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "reasonCode" "DischargeHoldReason" NOT NULL,
    "placedByUserId" TEXT NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedByUserId" TEXT,
    "clearedAt" TIMESTAMP(3),
    CONSTRAINT "DischargeHold_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DischargeHold_dischargeId_idx" ON "DischargeHold"("dischargeId");
CREATE INDEX "DischargeHold_facilityId_clearedAt_idx" ON "DischargeHold"("facilityId", "clearedAt");
ALTER TABLE "DischargeHold" ADD CONSTRAINT "DischargeHold_dischargeId_fkey"
  FOREIGN KEY ("dischargeId") REFERENCES "Discharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one active hold per reason on a discharge; a cleared hold is history.
CREATE UNIQUE INDEX "DischargeHold_one_active_per_reason" ON "DischargeHold"("dischargeId", "reasonCode") WHERE "clearedAt" IS NULL;
-- Cleared means both who and when.
ALTER TABLE "DischargeHold" ADD CONSTRAINT "DischargeHold_cleared_check"
  CHECK (("clearedAt" IS NULL) = ("clearedByUserId" IS NULL));
