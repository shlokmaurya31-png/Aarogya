-- AlterTable
ALTER TABLE "BillingPaymentAttempt" ADD COLUMN "failureCode" TEXT;
ALTER TABLE "BillingPaymentAttempt" ADD COLUMN "providerRequestRef" TEXT;

-- AlterTable
ALTER TABLE "BillingWebhookEvent" ADD COLUMN "lastErrorCode" TEXT;
ALTER TABLE "BillingWebhookEvent" ADD COLUMN "lastErrorMessage" TEXT;
ALTER TABLE "BillingWebhookEvent" ADD COLUMN "normalizedType" TEXT;
ALTER TABLE "BillingWebhookEvent" ADD COLUMN "providerResourceRef" TEXT;
ALTER TABLE "BillingWebhookEvent" ADD COLUMN "verifiedAt" DATETIME;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_BillingReconciliationException" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "entityType" TEXT,
    "entityId" TEXT,
    "description" TEXT,
    "detail" JSONB,
    "providerKind" TEXT NOT NULL DEFAULT 'NONE',
    "providerRef" TEXT,
    "localRef" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME
);
INSERT INTO "new_BillingReconciliationException" ("createdAt", "detail", "id", "kind", "organizationId", "providerKind", "providerRef", "resolved", "resolvedAt") SELECT "createdAt", "detail", "id", "kind", "organizationId", "providerKind", "providerRef", "resolved", "resolvedAt" FROM "BillingReconciliationException";
DROP TABLE "BillingReconciliationException";
ALTER TABLE "new_BillingReconciliationException" RENAME TO "BillingReconciliationException";
CREATE INDEX "BillingReconciliationException_resolved_idx" ON "BillingReconciliationException"("resolved");
CREATE INDEX "BillingReconciliationException_organizationId_idx" ON "BillingReconciliationException"("organizationId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
