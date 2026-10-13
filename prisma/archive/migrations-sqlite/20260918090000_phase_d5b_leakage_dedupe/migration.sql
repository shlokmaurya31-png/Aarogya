-- Phase D5b — race-safe leakage de-duplication key (SQLite).
ALTER TABLE "BillingReconciliationException" ADD COLUMN "findingKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "BillingReconciliationException_findingKey_key" ON "BillingReconciliationException"("findingKey");
