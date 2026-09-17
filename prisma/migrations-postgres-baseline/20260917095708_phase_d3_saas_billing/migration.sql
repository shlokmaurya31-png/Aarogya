-- Phase D3 — SaaS billing & payment infrastructure (PostgreSQL).
-- Mirrors prisma/migrations/20260917095708_phase_d3_saas_billing.
--
-- Strictly additive: twelve new tables + twelve new enum types + two new
-- relation fields onto existing rows (no column retype, no DROP/DELETE/TRUNCATE,
-- no change to any existing table's data). On PostgreSQL, Prisma enums are native
-- enum TYPES (the SQLite tree uses TEXT); they are created before the columns
-- that use them. Foreign keys are declared after every table exists so a replay
-- from zero is safe. Longest identifier is
-- BillingWebhookEvent_providerKind_externalEventId_key (52 chars), comfortably
-- under PostgreSQL's 63-char limit.
--
-- No business data is seeded here. Pricing and per-organization billing accounts
-- are materialised idempotently by ensureBillingBootstrap()
-- (src/lib/billing/bootstrap.ts); no historical invoices or payments are ever
-- fabricated. See docs/enterprise/saas-billing.md.

-- CreateEnum
CREATE TYPE "OrgBillingAccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');
CREATE TYPE "BillingProviderKind" AS ENUM ('NONE', 'FAKE');
CREATE TYPE "BillingPeriodStatus" AS ENUM ('ACTIVE', 'INVOICED', 'CLOSED');
CREATE TYPE "BillingInvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PARTIALLY_PAID', 'PAID', 'PAST_DUE', 'VOID', 'UNCOLLECTIBLE');
CREATE TYPE "BillingInvoiceLineType" AS ENUM ('SUBSCRIPTION', 'ADDITIONAL_FACILITY', 'ADDITIONAL_USER', 'ADJUSTMENT', 'CREDIT', 'TAX');
CREATE TYPE "BillingPaymentAttemptStatus" AS ENUM ('INITIATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "BillingPaymentStatus" AS ENUM ('SUCCEEDED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'VOID');
CREATE TYPE "BillingRefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "BillingCreditType" AS ENUM ('PROMOTIONAL', 'MANUAL', 'CORRECTION', 'CONTRACT');
CREATE TYPE "BillingCreditStatus" AS ENUM ('ACTIVE', 'APPLIED', 'VOID');
CREATE TYPE "BillingWebhookStatus" AS ENUM ('RECEIVED', 'VERIFIED', 'PROCESSED', 'FAILED', 'REJECTED', 'IGNORED');
CREATE TYPE "BillingReconciliationKind" AS ENUM ('MISSING_PROVIDER_PAYMENT', 'DUPLICATE_EVENT', 'STATE_MISMATCH', 'UNKNOWN_REFERENCE', 'STUCK_PAYMENT', 'REFUND_MISMATCH');

-- CreateTable
CREATE TABLE "OrganizationBillingAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "billingName" TEXT NOT NULL,
    "billingEmail" TEXT NOT NULL,
    "billingAddress" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "taxId" TEXT,
    "status" "OrgBillingAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "providerKind" "BillingProviderKind" NOT NULL DEFAULT 'NONE',
    "providerCustomerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationBillingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanPrice" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "billingInterval" "BillingInterval" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "amountMinor" INTEGER NOT NULL,
    "taxCode" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPeriod" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "billingInterval" "BillingInterval" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "BillingPeriodStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingInvoice" (
    "id" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "organizationId" TEXT NOT NULL,
    "billingAccountId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "billingPeriodId" TEXT,
    "status" "BillingInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "subtotalMinor" INTEGER NOT NULL DEFAULT 0,
    "discountMinor" INTEGER NOT NULL DEFAULT 0,
    "taxMinor" INTEGER NOT NULL DEFAULT 0,
    "totalMinor" INTEGER NOT NULL DEFAULT 0,
    "amountPaidMinor" INTEGER NOT NULL DEFAULT 0,
    "status_reason" TEXT,
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "generatedByUserId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingInvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "type" "BillingInvoiceLineType" NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitAmountMinor" INTEGER NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "taxCode" TEXT,
    "taxRateBps" INTEGER NOT NULL DEFAULT 0,
    "taxAmountMinor" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingInvoiceSequence" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'SAAS',
    "fiscalYear" INTEGER NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "BillingInvoiceSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPaymentAttempt" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "BillingPaymentAttemptStatus" NOT NULL DEFAULT 'INITIATED',
    "idempotencyKey" TEXT NOT NULL,
    "providerKind" "BillingProviderKind" NOT NULL DEFAULT 'NONE',
    "providerPaymentRef" TEXT,
    "failureReason" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingPaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPayment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "attemptId" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "refundedMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "BillingPaymentStatus" NOT NULL DEFAULT 'SUCCEEDED',
    "method" TEXT,
    "providerKind" "BillingProviderKind" NOT NULL DEFAULT 'NONE',
    "providerPaymentRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "succeededAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingRefund" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "BillingRefundStatus" NOT NULL DEFAULT 'SUCCEEDED',
    "idempotencyKey" TEXT NOT NULL,
    "providerKind" "BillingProviderKind" NOT NULL DEFAULT 'NONE',
    "providerRefundRef" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingCredit" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "remainingMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "type" "BillingCreditType" NOT NULL,
    "status" "BillingCreditStatus" NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingCredit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingWebhookEvent" (
    "id" TEXT NOT NULL,
    "providerKind" "BillingProviderKind" NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "signatureVerified" BOOLEAN NOT NULL DEFAULT false,
    "status" "BillingWebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "processingResult" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "BillingWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingReconciliationException" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "kind" "BillingReconciliationKind" NOT NULL,
    "detail" JSONB,
    "providerKind" "BillingProviderKind" NOT NULL DEFAULT 'NONE',
    "providerRef" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "BillingReconciliationException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationBillingAccount_organizationId_key" ON "OrganizationBillingAccount"("organizationId");
CREATE INDEX "OrganizationBillingAccount_status_idx" ON "OrganizationBillingAccount"("status");
CREATE INDEX "PlanPrice_planId_billingInterval_active_idx" ON "PlanPrice"("planId", "billingInterval", "active");
CREATE INDEX "BillingPeriod_organizationId_idx" ON "BillingPeriod"("organizationId");
CREATE INDEX "BillingPeriod_status_idx" ON "BillingPeriod"("status");
CREATE UNIQUE INDEX "BillingPeriod_subscriptionId_periodStart_key" ON "BillingPeriod"("subscriptionId", "periodStart");
CREATE UNIQUE INDEX "BillingInvoice_invoiceNumber_key" ON "BillingInvoice"("invoiceNumber");
CREATE UNIQUE INDEX "BillingInvoice_billingPeriodId_key" ON "BillingInvoice"("billingPeriodId");
CREATE UNIQUE INDEX "BillingInvoice_idempotencyKey_key" ON "BillingInvoice"("idempotencyKey");
CREATE INDEX "BillingInvoice_organizationId_status_idx" ON "BillingInvoice"("organizationId", "status");
CREATE INDEX "BillingInvoice_billingAccountId_idx" ON "BillingInvoice"("billingAccountId");
CREATE INDEX "BillingInvoiceLine_invoiceId_idx" ON "BillingInvoiceLine"("invoiceId");
CREATE UNIQUE INDEX "BillingInvoiceSequence_scope_fiscalYear_key" ON "BillingInvoiceSequence"("scope", "fiscalYear");
CREATE UNIQUE INDEX "BillingPaymentAttempt_idempotencyKey_key" ON "BillingPaymentAttempt"("idempotencyKey");
CREATE INDEX "BillingPaymentAttempt_invoiceId_idx" ON "BillingPaymentAttempt"("invoiceId");
CREATE INDEX "BillingPaymentAttempt_organizationId_idx" ON "BillingPaymentAttempt"("organizationId");
CREATE UNIQUE INDEX "BillingPayment_attemptId_key" ON "BillingPayment"("attemptId");
CREATE UNIQUE INDEX "BillingPayment_providerPaymentRef_key" ON "BillingPayment"("providerPaymentRef");
CREATE UNIQUE INDEX "BillingPayment_idempotencyKey_key" ON "BillingPayment"("idempotencyKey");
CREATE INDEX "BillingPayment_invoiceId_idx" ON "BillingPayment"("invoiceId");
CREATE INDEX "BillingPayment_organizationId_idx" ON "BillingPayment"("organizationId");
CREATE UNIQUE INDEX "BillingRefund_idempotencyKey_key" ON "BillingRefund"("idempotencyKey");
CREATE INDEX "BillingRefund_paymentId_idx" ON "BillingRefund"("paymentId");
CREATE INDEX "BillingRefund_organizationId_idx" ON "BillingRefund"("organizationId");
CREATE INDEX "BillingCredit_organizationId_status_idx" ON "BillingCredit"("organizationId", "status");
CREATE INDEX "BillingCredit_invoiceId_idx" ON "BillingCredit"("invoiceId");
CREATE INDEX "BillingWebhookEvent_status_idx" ON "BillingWebhookEvent"("status");
CREATE UNIQUE INDEX "BillingWebhookEvent_providerKind_externalEventId_key" ON "BillingWebhookEvent"("providerKind", "externalEventId");
CREATE INDEX "BillingReconciliationException_resolved_idx" ON "BillingReconciliationException"("resolved");
CREATE INDEX "BillingReconciliationException_organizationId_idx" ON "BillingReconciliationException"("organizationId");

-- AddForeignKey
ALTER TABLE "OrganizationBillingAccount" ADD CONSTRAINT "OrganizationBillingAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlanPrice" ADD CONSTRAINT "PlanPrice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BillingPeriod" ADD CONSTRAINT "BillingPeriod_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "OrganizationSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_billingAccountId_fkey" FOREIGN KEY ("billingAccountId") REFERENCES "OrganizationBillingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "OrganizationSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BillingInvoiceLine" ADD CONSTRAINT "BillingInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BillingInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BillingPaymentAttempt" ADD CONSTRAINT "BillingPaymentAttempt_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BillingInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BillingInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "BillingPaymentAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BillingRefund" ADD CONSTRAINT "BillingRefund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "BillingPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BillingCredit" ADD CONSTRAINT "BillingCredit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BillingCredit" ADD CONSTRAINT "BillingCredit_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BillingInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
