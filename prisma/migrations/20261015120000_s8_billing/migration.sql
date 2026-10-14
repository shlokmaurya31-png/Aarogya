-- Section 8 schema clean-up, billing domain (docs/POSTGRES_CUTOVER_REPORT.md §8).
-- Every conversion is guarded: if any existing row holds a value outside the
-- target set, the migration stops and names the values instead of guessing.

-- Refund gets the facility of its payment (§8.4), so its idempotency key can
-- be unique per facility. A refund whose payment can't be found stops the
-- migration.
ALTER TABLE "Refund" ADD COLUMN "facilityId" TEXT;
UPDATE "Refund" r SET "facilityId" = p."facilityId" FROM "Payment" p WHERE p."id" = r."paymentId";
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "Refund" WHERE "facilityId" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'Refund: % row(s) have no payment to take a facility from; resolve before migrating', n; END IF;
END $$;
ALTER TABLE "Refund" ALTER COLUMN "facilityId" SET NOT NULL;
CREATE INDEX "Refund_facilityId_idx" ON "Refund"("facilityId");
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(DISTINCT COALESCE("currency"::text, 'NULL'), ', ') INTO bad FROM "OrganizationBillingAccount" WHERE "currency" !~ '^[A-Z]{3}$';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'OrganizationBillingAccount.currency holds values outside 3-letter ISO 4217 codes: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("currency"::text, 'NULL'), ', ') INTO bad FROM "PlanPrice" WHERE "currency" !~ '^[A-Z]{3}$';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'PlanPrice.currency holds values outside 3-letter ISO 4217 codes: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("currency"::text, 'NULL'), ', ') INTO bad FROM "BillingInvoice" WHERE "currency" !~ '^[A-Z]{3}$';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'BillingInvoice.currency holds values outside 3-letter ISO 4217 codes: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("currency"::text, 'NULL'), ', ') INTO bad FROM "BillingPaymentAttempt" WHERE "currency" !~ '^[A-Z]{3}$';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'BillingPaymentAttempt.currency holds values outside 3-letter ISO 4217 codes: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("currency"::text, 'NULL'), ', ') INTO bad FROM "BillingPayment" WHERE "currency" !~ '^[A-Z]{3}$';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'BillingPayment.currency holds values outside 3-letter ISO 4217 codes: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("currency"::text, 'NULL'), ', ') INTO bad FROM "BillingCredit" WHERE "currency" !~ '^[A-Z]{3}$';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'BillingCredit.currency holds values outside 3-letter ISO 4217 codes: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("severity"::text, 'NULL'), ', ') INTO bad FROM "BillingReconciliationException" WHERE "severity" NOT IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'BillingReconciliationException.severity holds values outside ReconciliationSeverity: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("status"::text, 'NULL'), ', ') INTO bad FROM "BillingReconciliationException" WHERE "status" NOT IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'BillingReconciliationException.status holds values outside BillingReconciliationExceptionStatus: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("source"::text, 'NULL'), ', ') INTO bad FROM "BillingReconciliationException" WHERE "source" NOT IN ('RECONCILIATION', 'LEAKAGE');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'BillingReconciliationException.source holds values outside the allowed set: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("type"::text, 'NULL'), ', ') INTO bad FROM "CollectionActivity" WHERE "type" NOT IN ('NOTE', 'CONTACT', 'PROMISE_TO_PAY', 'ESCALATION');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'CollectionActivity.type holds values outside the allowed set: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("category"::text, 'NULL'), ', ') INTO bad FROM "Charge" WHERE "category" NOT IN ('CONSULTATION', 'BED', 'PROCEDURE', 'LAB', 'IMAGING', 'PHARMACY', 'NURSING', 'PACKAGE', 'OTHER');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Charge.category holds values outside the allowed set: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("currency"::text, 'NULL'), ', ') INTO bad FROM "Charge" WHERE "currency" !~ '^[A-Z]{3}$';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Charge.currency holds values outside 3-letter ISO 4217 codes: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("currency"::text, 'NULL'), ', ') INTO bad FROM "Tariff" WHERE "currency" !~ '^[A-Z]{3}$';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Tariff.currency holds values outside 3-letter ISO 4217 codes: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("currency"::text, 'NULL'), ', ') INTO bad FROM "PackageDefinition" WHERE "currency" !~ '^[A-Z]{3}$';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'PackageDefinition.currency holds values outside 3-letter ISO 4217 codes: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("currency"::text, 'NULL'), ', ') INTO bad FROM "Invoice" WHERE "currency" !~ '^[A-Z]{3}$';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Invoice.currency holds values outside 3-letter ISO 4217 codes: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("currency"::text, 'NULL'), ', ') INTO bad FROM "Payment" WHERE "currency" !~ '^[A-Z]{3}$';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Payment.currency holds values outside 3-letter ISO 4217 codes: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("submissionType"::text, 'NULL'), ', ') INTO bad FROM "ClaimSubmission" WHERE "submissionType" NOT IN ('ORIGINAL', 'RESUBMISSION', 'APPEAL');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'ClaimSubmission.submissionType holds values outside ClaimSubmissionSubmissionType: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("status"::text, 'NULL'), ', ') INTO bad FROM "ClaimSubmission" WHERE "status" NOT IN ('DRAFT', 'READY', 'SUBMITTED', 'ACKNOWLEDGED', 'ACCEPTED', 'REJECTED', 'FAILED', 'SUPERSEDED');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'ClaimSubmission.status holds values outside ClaimSubmissionStatus: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("direction"::text, 'NULL'), ', ') INTO bad FROM "NhcxExchange" WHERE "direction" NOT IN ('OUTBOUND', 'INBOUND');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'NhcxExchange.direction holds values outside ExchangeDirection: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("status"::text, 'NULL'), ', ') INTO bad FROM "NhcxCallbackEvent" WHERE "status" NOT IN ('ACCEPTED', 'REJECTED', 'DUPLICATE', 'UNMATCHED');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'NhcxCallbackEvent.status holds values outside NhcxCallbackEventStatus: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("status"::text, 'NULL'), ', ') INTO bad FROM "ClaimQuery" WHERE "status" NOT IN ('RECEIVED', 'UNDER_REVIEW', 'RESPONSE_DRAFT', 'RESPONSE_SUBMITTED', 'ACKNOWLEDGED', 'RESOLVED', 'CLOSED');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'ClaimQuery.status holds values outside ClaimQueryStatus: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("status"::text, 'NULL'), ', ') INTO bad FROM "ClaimSettlement" WHERE "status" NOT IN ('NOTIFIED', 'RECONCILED', 'DISPUTED', 'REJECTED');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'ClaimSettlement.status holds values outside ClaimSettlementStatus: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("severity"::text, 'NULL'), ', ') INTO bad FROM "ReconciliationException" WHERE "severity" NOT IN ('INFO', 'WARNING', 'CRITICAL');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'ReconciliationException.severity holds values outside AlertSeverity: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("status"::text, 'NULL'), ', ') INTO bad FROM "ReconciliationException" WHERE "status" NOT IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'ReconciliationException.status holds values outside ReconciliationExceptionStatus: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("facilityId"::text, 'NULL'), ', ') INTO bad FROM "Payment" WHERE "facilityId" IS NULL AND "idempotencyKey" IS NOT NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Payment.facilityId holds values outside a tenant (facilityId) for every keyed row: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("facilityId"::text, 'NULL'), ', ') INTO bad FROM "Refund" WHERE "facilityId" IS NULL AND "idempotencyKey" IS NOT NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Refund.facilityId holds values outside a tenant (facilityId) for every keyed row: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("facilityId"::text, 'NULL'), ', ') INTO bad FROM "NhcxExchange" WHERE "facilityId" IS NULL AND "idempotencyKey" IS NOT NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'NhcxExchange.facilityId holds values outside a tenant (facilityId) for every keyed row: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("organizationId"::text, 'NULL'), ', ') INTO bad FROM "BillingInvoice" WHERE "organizationId" IS NULL AND "idempotencyKey" IS NOT NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'BillingInvoice.organizationId holds values outside a tenant (organizationId) for every keyed row: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("organizationId"::text, 'NULL'), ', ') INTO bad FROM "BillingPaymentAttempt" WHERE "organizationId" IS NULL AND "idempotencyKey" IS NOT NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'BillingPaymentAttempt.organizationId holds values outside a tenant (organizationId) for every keyed row: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("organizationId"::text, 'NULL'), ', ') INTO bad FROM "BillingPayment" WHERE "organizationId" IS NULL AND "idempotencyKey" IS NOT NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'BillingPayment.organizationId holds values outside a tenant (organizationId) for every keyed row: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("organizationId"::text, 'NULL'), ', ') INTO bad FROM "BillingRefund" WHERE "organizationId" IS NULL AND "idempotencyKey" IS NOT NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'BillingRefund.organizationId holds values outside a tenant (organizationId) for every keyed row: %; resolve before migrating', bad; END IF;
END $$;

ALTER TABLE "OrganizationBillingAccount" ADD CONSTRAINT "OrganizationBillingAccount_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "PlanPrice" ADD CONSTRAINT "PlanPrice_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "BillingPaymentAttempt" ADD CONSTRAINT "BillingPaymentAttempt_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "BillingCredit" ADD CONSTRAINT "BillingCredit_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
CREATE TYPE "ReconciliationSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
ALTER TABLE "BillingReconciliationException" ALTER COLUMN "severity" DROP DEFAULT, ALTER COLUMN "severity" TYPE "ReconciliationSeverity" USING "severity"::text::"ReconciliationSeverity", ALTER COLUMN "severity" SET DEFAULT 'MEDIUM';
CREATE TYPE "BillingReconciliationExceptionStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');
ALTER TABLE "BillingReconciliationException" ALTER COLUMN "status" DROP DEFAULT, ALTER COLUMN "status" TYPE "BillingReconciliationExceptionStatus" USING "status"::text::"BillingReconciliationExceptionStatus", ALTER COLUMN "status" SET DEFAULT 'OPEN';
ALTER TABLE "BillingReconciliationException" ADD CONSTRAINT "BillingReconciliationException_source_check" CHECK ("source" IN ('RECONCILIATION', 'LEAKAGE'));
ALTER TABLE "CollectionActivity" ADD CONSTRAINT "CollectionActivity_type_check" CHECK ("type" IN ('NOTE', 'CONTACT', 'PROMISE_TO_PAY', 'ESCALATION'));
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_category_check" CHECK ("category" IN ('CONSULTATION', 'BED', 'PROCEDURE', 'LAB', 'IMAGING', 'PHARMACY', 'NURSING', 'PACKAGE', 'OTHER'));
ALTER TABLE "Charge" ADD CONSTRAINT "Charge_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "Tariff" ADD CONSTRAINT "Tariff_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "PackageDefinition" ADD CONSTRAINT "PackageDefinition_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
CREATE TYPE "ClaimSubmissionSubmissionType" AS ENUM ('ORIGINAL', 'RESUBMISSION', 'APPEAL');
ALTER TABLE "ClaimSubmission" ALTER COLUMN "submissionType" DROP DEFAULT, ALTER COLUMN "submissionType" TYPE "ClaimSubmissionSubmissionType" USING "submissionType"::text::"ClaimSubmissionSubmissionType", ALTER COLUMN "submissionType" SET DEFAULT 'ORIGINAL';
CREATE TYPE "ClaimSubmissionStatus" AS ENUM ('DRAFT', 'READY', 'SUBMITTED', 'ACKNOWLEDGED', 'ACCEPTED', 'REJECTED', 'FAILED', 'SUPERSEDED');
ALTER TABLE "ClaimSubmission" ALTER COLUMN "status" DROP DEFAULT, ALTER COLUMN "status" TYPE "ClaimSubmissionStatus" USING "status"::text::"ClaimSubmissionStatus", ALTER COLUMN "status" SET DEFAULT 'DRAFT';
CREATE TYPE "ExchangeDirection" AS ENUM ('OUTBOUND', 'INBOUND');
ALTER TABLE "NhcxExchange" ALTER COLUMN "direction" DROP DEFAULT, ALTER COLUMN "direction" TYPE "ExchangeDirection" USING "direction"::text::"ExchangeDirection", ALTER COLUMN "direction" SET DEFAULT 'OUTBOUND';
CREATE TYPE "NhcxCallbackEventStatus" AS ENUM ('ACCEPTED', 'REJECTED', 'DUPLICATE', 'UNMATCHED');
ALTER TABLE "NhcxCallbackEvent" ALTER COLUMN "status" DROP DEFAULT, ALTER COLUMN "status" TYPE "NhcxCallbackEventStatus" USING "status"::text::"NhcxCallbackEventStatus", ALTER COLUMN "status" SET DEFAULT 'ACCEPTED';
CREATE TYPE "ClaimQueryStatus" AS ENUM ('RECEIVED', 'UNDER_REVIEW', 'RESPONSE_DRAFT', 'RESPONSE_SUBMITTED', 'ACKNOWLEDGED', 'RESOLVED', 'CLOSED');
ALTER TABLE "ClaimQuery" ALTER COLUMN "status" DROP DEFAULT, ALTER COLUMN "status" TYPE "ClaimQueryStatus" USING "status"::text::"ClaimQueryStatus", ALTER COLUMN "status" SET DEFAULT 'RECEIVED';
CREATE TYPE "ClaimSettlementStatus" AS ENUM ('NOTIFIED', 'RECONCILED', 'DISPUTED', 'REJECTED');
ALTER TABLE "ClaimSettlement" ALTER COLUMN "status" DROP DEFAULT, ALTER COLUMN "status" TYPE "ClaimSettlementStatus" USING "status"::text::"ClaimSettlementStatus", ALTER COLUMN "status" SET DEFAULT 'NOTIFIED';
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');
ALTER TABLE "ReconciliationException" ALTER COLUMN "severity" DROP DEFAULT, ALTER COLUMN "severity" TYPE "AlertSeverity" USING "severity"::text::"AlertSeverity", ALTER COLUMN "severity" SET DEFAULT 'WARNING';
CREATE TYPE "ReconciliationExceptionStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED');
ALTER TABLE "ReconciliationException" ALTER COLUMN "status" DROP DEFAULT, ALTER COLUMN "status" TYPE "ReconciliationExceptionStatus" USING "status"::text::"ReconciliationExceptionStatus", ALTER COLUMN "status" SET DEFAULT 'OPEN';
DROP INDEX "Payment_idempotencyKey_key";
CREATE UNIQUE INDEX "Payment_facilityId_idempotencyKey_key" ON "Payment"("facilityId", "idempotencyKey");
DROP INDEX "Refund_idempotencyKey_key";
CREATE UNIQUE INDEX "Refund_facilityId_idempotencyKey_key" ON "Refund"("facilityId", "idempotencyKey");
DROP INDEX "NhcxExchange_idempotencyKey_key";
CREATE UNIQUE INDEX "NhcxExchange_facilityId_idempotencyKey_key" ON "NhcxExchange"("facilityId", "idempotencyKey");
DROP INDEX "BillingInvoice_idempotencyKey_key";
CREATE UNIQUE INDEX "BillingInvoice_organizationId_idempotencyKey_key" ON "BillingInvoice"("organizationId", "idempotencyKey");
DROP INDEX "BillingPaymentAttempt_idempotencyKey_key";
CREATE UNIQUE INDEX "BillingPaymentAttempt_organizationId_idempotencyKey_key" ON "BillingPaymentAttempt"("organizationId", "idempotencyKey");
DROP INDEX "BillingPayment_idempotencyKey_key";
CREATE UNIQUE INDEX "BillingPayment_organizationId_idempotencyKey_key" ON "BillingPayment"("organizationId", "idempotencyKey");
DROP INDEX "BillingRefund_idempotencyKey_key";
CREATE UNIQUE INDEX "BillingRefund_organizationId_idempotencyKey_key" ON "BillingRefund"("organizationId", "idempotencyKey");
