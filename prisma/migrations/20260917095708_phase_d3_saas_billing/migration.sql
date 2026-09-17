-- CreateTable
CREATE TABLE "OrganizationBillingAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "billingName" TEXT NOT NULL,
    "billingEmail" TEXT NOT NULL,
    "billingAddress" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "taxId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "providerKind" TEXT NOT NULL DEFAULT 'NONE',
    "providerCustomerRef" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrganizationBillingAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlanPrice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL,
    "billingInterval" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "amountMinor" INTEGER NOT NULL,
    "taxCode" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanPrice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BillingPeriod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "subscriptionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "billingInterval" TEXT NOT NULL,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingPeriod_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "OrganizationSubscription" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BillingInvoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceNumber" TEXT,
    "organizationId" TEXT NOT NULL,
    "billingAccountId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "billingPeriodId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "subtotalMinor" INTEGER NOT NULL DEFAULT 0,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "taxMinor" INTEGER NOT NULL DEFAULT 0,
    "totalMinor" INTEGER NOT NULL DEFAULT 0,
    "amountPaidMinor" INTEGER NOT NULL DEFAULT 0,
    "status_reason" TEXT,
    "issuedAt" DATETIME,
    "dueAt" DATETIME,
    "finalizedAt" DATETIME,
    "voidedAt" DATETIME,
    "voidReason" TEXT,
    "generatedByUserId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingInvoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BillingInvoice_billingAccountId_fkey" FOREIGN KEY ("billingAccountId") REFERENCES "OrganizationBillingAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BillingInvoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "OrganizationSubscription" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BillingInvoice_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BillingInvoiceLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitAmountMinor" INTEGER NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "taxCode" TEXT,
    "taxRateBps" INTEGER NOT NULL DEFAULT 0,
    "taxAmountMinor" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BillingInvoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BillingInvoiceSequence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL DEFAULT 'SAAS',
    "fiscalYear" INTEGER NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1
);

-- CreateTable
CREATE TABLE "BillingPaymentAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL DEFAULT 'INITIATED',
    "idempotencyKey" TEXT NOT NULL,
    "providerKind" TEXT NOT NULL DEFAULT 'NONE',
    "providerPaymentRef" TEXT,
    "failureReason" TEXT,
    "createdByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingPaymentAttempt_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BillingInvoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BillingPayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "attemptId" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "refundedMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" TEXT NOT NULL DEFAULT 'SUCCEEDED',
    "method" TEXT,
    "providerKind" TEXT NOT NULL DEFAULT 'NONE',
    "providerPaymentRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "succeededAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BillingInvoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BillingPayment_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "BillingPaymentAttempt" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BillingRefund" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paymentId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUCCEEDED',
    "idempotencyKey" TEXT NOT NULL,
    "providerKind" TEXT NOT NULL DEFAULT 'NONE',
    "providerRefundRef" TEXT,
    "createdByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingRefund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "BillingPayment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BillingCredit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "remainingMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingCredit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BillingCredit_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BillingInvoice" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BillingWebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerKind" TEXT NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "processingResult" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME
);

-- CreateTable
CREATE TABLE "BillingReconciliationException" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT,
    "kind" TEXT NOT NULL,
    "detail" JSONB,
    "providerKind" TEXT NOT NULL DEFAULT 'NONE',
    "providerRef" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationBillingAccount_organizationId_key" ON "OrganizationBillingAccount"("organizationId");

-- CreateIndex
CREATE INDEX "OrganizationBillingAccount_status_idx" ON "OrganizationBillingAccount"("status");

-- CreateIndex
CREATE INDEX "PlanPrice_planId_billingInterval_active_idx" ON "PlanPrice"("planId", "billingInterval", "active");

-- CreateIndex
CREATE INDEX "BillingPeriod_organizationId_idx" ON "BillingPeriod"("organizationId");

-- CreateIndex
CREATE INDEX "BillingPeriod_status_idx" ON "BillingPeriod"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPeriod_subscriptionId_periodStart_key" ON "BillingPeriod"("subscriptionId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "BillingInvoice_invoiceNumber_key" ON "BillingInvoice"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "BillingInvoice_billingPeriodId_key" ON "BillingInvoice"("billingPeriodId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingInvoice_idempotencyKey_key" ON "BillingInvoice"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BillingInvoice_organizationId_status_idx" ON "BillingInvoice"("organizationId", "status");

-- CreateIndex
CREATE INDEX "BillingInvoice_billingAccountId_idx" ON "BillingInvoice"("billingAccountId");

-- CreateIndex
CREATE INDEX "BillingInvoiceLine_invoiceId_idx" ON "BillingInvoiceLine"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingInvoiceSequence_scope_fiscalYear_key" ON "BillingInvoiceSequence"("scope", "fiscalYear");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPaymentAttempt_idempotencyKey_key" ON "BillingPaymentAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BillingPaymentAttempt_invoiceId_idx" ON "BillingPaymentAttempt"("invoiceId");

-- CreateIndex
CREATE INDEX "BillingPaymentAttempt_organizationId_idx" ON "BillingPaymentAttempt"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPayment_attemptId_key" ON "BillingPayment"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPayment_providerPaymentRef_key" ON "BillingPayment"("providerPaymentRef");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPayment_idempotencyKey_key" ON "BillingPayment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BillingPayment_invoiceId_idx" ON "BillingPayment"("invoiceId");

-- CreateIndex
CREATE INDEX "BillingPayment_organizationId_idx" ON "BillingPayment"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingRefund_idempotencyKey_key" ON "BillingRefund"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BillingRefund_paymentId_idx" ON "BillingRefund"("paymentId");

-- CreateIndex
CREATE INDEX "BillingRefund_organizationId_idx" ON "BillingRefund"("organizationId");

-- CreateIndex
CREATE INDEX "BillingCredit_organizationId_status_idx" ON "BillingCredit"("organizationId", "status");

-- CreateIndex
CREATE INDEX "BillingCredit_invoiceId_idx" ON "BillingCredit"("invoiceId");

-- CreateIndex
CREATE INDEX "BillingWebhookEvent_status_idx" ON "BillingWebhookEvent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BillingWebhookEvent_providerKind_externalEventId_key" ON "BillingWebhookEvent"("providerKind", "externalEventId");

-- CreateIndex
CREATE INDEX "BillingReconciliationException_resolved_idx" ON "BillingReconciliationException"("resolved");

-- CreateIndex
CREATE INDEX "BillingReconciliationException_organizationId_idx" ON "BillingReconciliationException"("organizationId");
