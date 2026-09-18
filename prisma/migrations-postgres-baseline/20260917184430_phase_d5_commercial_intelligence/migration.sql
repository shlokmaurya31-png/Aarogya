-- Phase D5 — enterprise finance / revenue operations / commercial intelligence (PostgreSQL).
-- Mirrors prisma/migrations/20260917184430_phase_d5_commercial_intelligence.
--
-- Strictly additive: 4 new enum values, new nullable/defaulted columns on
-- BillingReconciliationException, one new table (CollectionActivity), and read-
-- path indexes. No DROP, no retype, no data change. On PostgreSQL the exception
-- additions are plain ADD COLUMN (no table rebuild — that is a SQLite-only
-- limitation). Enum values are added with ALTER TYPE ADD VALUE (not referenced in
-- this migration, so transaction-safe).

-- AlterEnum
ALTER TYPE "BillingReconciliationKind" ADD VALUE IF NOT EXISTS 'MISSING_INVOICE';
ALTER TYPE "BillingReconciliationKind" ADD VALUE IF NOT EXISTS 'DUPLICATE_RENEWAL';
ALTER TYPE "BillingReconciliationKind" ADD VALUE IF NOT EXISTS 'ORPHAN_PAYMENT';
ALTER TYPE "BillingReconciliationKind" ADD VALUE IF NOT EXISTS 'COMMERCIAL_STATE_MISMATCH';

-- AlterTable
ALTER TABLE "BillingReconciliationException" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'OPEN';
ALTER TABLE "BillingReconciliationException" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'RECONCILIATION';
ALTER TABLE "BillingReconciliationException" ADD COLUMN "assignedToUserId" TEXT;
ALTER TABLE "BillingReconciliationException" ADD COLUMN "resolution" TEXT;

-- CreateTable
CREATE TABLE "CollectionActivity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillingReconciliationException_status_idx" ON "BillingReconciliationException"("status");
CREATE INDEX "BillingReconciliationException_severity_idx" ON "BillingReconciliationException"("severity");
CREATE INDEX "CollectionActivity_organizationId_createdAt_idx" ON "CollectionActivity"("organizationId", "createdAt");
CREATE INDEX "BillingInvoice_dueAt_idx" ON "BillingInvoice"("dueAt");
CREATE INDEX "BillingInvoice_finalizedAt_idx" ON "BillingInvoice"("finalizedAt");
CREATE INDEX "BillingPayment_status_succeededAt_idx" ON "BillingPayment"("status", "succeededAt");

-- AddForeignKey
ALTER TABLE "CollectionActivity" ADD CONSTRAINT "CollectionActivity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
