-- Phase D4 — provider productionization (PostgreSQL).
-- Mirrors prisma/migrations/20260917111013_phase_d4_provider_productionization.
--
-- Strictly additive: one new enum value + new nullable/defaulted columns on three
-- existing tables. No DROP, no retype, no data change. On PostgreSQL the
-- reconciliation additions are plain ADD COLUMN (no table rebuild — that is a
-- SQLite-only limitation); the enum value is added with ALTER TYPE ADD VALUE
-- (not referenced within this migration, so it is transaction-safe).

-- AlterEnum
ALTER TYPE "BillingProviderKind" ADD VALUE IF NOT EXISTS 'RAZORPAY';

-- AlterTable
ALTER TABLE "BillingPaymentAttempt" ADD COLUMN "providerRequestRef" TEXT;
ALTER TABLE "BillingPaymentAttempt" ADD COLUMN "failureCode" TEXT;

-- AlterTable
ALTER TABLE "BillingWebhookEvent" ADD COLUMN "verifiedAt" TIMESTAMP(3);
ALTER TABLE "BillingWebhookEvent" ADD COLUMN "normalizedType" TEXT;
ALTER TABLE "BillingWebhookEvent" ADD COLUMN "providerResourceRef" TEXT;
ALTER TABLE "BillingWebhookEvent" ADD COLUMN "lastErrorCode" TEXT;
ALTER TABLE "BillingWebhookEvent" ADD COLUMN "lastErrorMessage" TEXT;

-- AlterTable
ALTER TABLE "BillingReconciliationException" ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'MEDIUM';
ALTER TABLE "BillingReconciliationException" ADD COLUMN "entityType" TEXT;
ALTER TABLE "BillingReconciliationException" ADD COLUMN "entityId" TEXT;
ALTER TABLE "BillingReconciliationException" ADD COLUMN "description" TEXT;
ALTER TABLE "BillingReconciliationException" ADD COLUMN "localRef" TEXT;
ALTER TABLE "BillingReconciliationException" ADD COLUMN "resolvedByUserId" TEXT;
