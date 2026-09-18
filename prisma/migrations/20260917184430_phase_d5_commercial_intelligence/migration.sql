-- CreateTable
CREATE TABLE "CollectionActivity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CollectionActivity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

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
    "resolvedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "source" TEXT NOT NULL DEFAULT 'RECONCILIATION',
    "assignedToUserId" TEXT,
    "resolution" TEXT
);
INSERT INTO "new_BillingReconciliationException" ("createdAt", "description", "detail", "entityId", "entityType", "id", "kind", "localRef", "organizationId", "providerKind", "providerRef", "resolved", "resolvedAt", "resolvedByUserId", "severity") SELECT "createdAt", "description", "detail", "entityId", "entityType", "id", "kind", "localRef", "organizationId", "providerKind", "providerRef", "resolved", "resolvedAt", "resolvedByUserId", "severity" FROM "BillingReconciliationException";
DROP TABLE "BillingReconciliationException";
ALTER TABLE "new_BillingReconciliationException" RENAME TO "BillingReconciliationException";
CREATE INDEX "BillingReconciliationException_resolved_idx" ON "BillingReconciliationException"("resolved");
CREATE INDEX "BillingReconciliationException_organizationId_idx" ON "BillingReconciliationException"("organizationId");
CREATE INDEX "BillingReconciliationException_status_idx" ON "BillingReconciliationException"("status");
CREATE INDEX "BillingReconciliationException_severity_idx" ON "BillingReconciliationException"("severity");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "CollectionActivity_organizationId_createdAt_idx" ON "CollectionActivity"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingInvoice_dueAt_idx" ON "BillingInvoice"("dueAt");

-- CreateIndex
CREATE INDEX "BillingInvoice_finalizedAt_idx" ON "BillingInvoice"("finalizedAt");

-- CreateIndex
CREATE INDEX "BillingPayment_status_succeededAt_idx" ON "BillingPayment"("status", "succeededAt");
