-- Section 8 schema clean-up, inventory domain (docs/POSTGRES_CUTOVER_REPORT.md §8).
-- Every conversion is guarded: if any existing row holds a value outside the
-- target set, the migration stops and names the values instead of guessing.

DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(DISTINCT COALESCE("urgency"::text, 'NULL'), ', ') INTO bad FROM "DepartmentSupplyRequest" WHERE "urgency" NOT IN ('ROUTINE', 'URGENT', 'STAT');
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'DepartmentSupplyRequest.urgency holds values outside Priority: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("currency"::text, 'NULL'), ', ') INTO bad FROM "PurchaseOrder" WHERE "currency" !~ '^[A-Z]{3}$';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'PurchaseOrder.currency holds values outside 3-letter ISO 4217 codes: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("currency"::text, 'NULL'), ', ') INTO bad FROM "SupplierContract" WHERE "currency" !~ '^[A-Z]{3}$';
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'SupplierContract.currency holds values outside 3-letter ISO 4217 codes: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("facilityId"::text, 'NULL'), ', ') INTO bad FROM "StockReservation" WHERE "facilityId" IS NULL AND "idempotencyKey" IS NOT NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'StockReservation.facilityId holds values outside a tenant (facilityId) for every keyed row: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("facilityId"::text, 'NULL'), ', ') INTO bad FROM "StockTransfer" WHERE "facilityId" IS NULL AND "idempotencyKey" IS NOT NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'StockTransfer.facilityId holds values outside a tenant (facilityId) for every keyed row: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("facilityId"::text, 'NULL'), ', ') INTO bad FROM "StockAdjustment" WHERE "facilityId" IS NULL AND "idempotencyKey" IS NOT NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'StockAdjustment.facilityId holds values outside a tenant (facilityId) for every keyed row: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("facilityId"::text, 'NULL'), ', ') INTO bad FROM "WasteRecord" WHERE "facilityId" IS NULL AND "idempotencyKey" IS NOT NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'WasteRecord.facilityId holds values outside a tenant (facilityId) for every keyed row: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("facilityId"::text, 'NULL'), ', ') INTO bad FROM "GoodsReceipt" WHERE "facilityId" IS NULL AND "idempotencyKey" IS NOT NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'GoodsReceipt.facilityId holds values outside a tenant (facilityId) for every keyed row: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("facilityId"::text, 'NULL'), ', ') INTO bad FROM "PurchaseRequisition" WHERE "facilityId" IS NULL AND "idempotencyKey" IS NOT NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'PurchaseRequisition.facilityId holds values outside a tenant (facilityId) for every keyed row: %; resolve before migrating', bad; END IF;
  SELECT string_agg(DISTINCT COALESCE("facilityId"::text, 'NULL'), ', ') INTO bad FROM "PurchaseOrder" WHERE "facilityId" IS NULL AND "idempotencyKey" IS NOT NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'PurchaseOrder.facilityId holds values outside a tenant (facilityId) for every keyed row: %; resolve before migrating', bad; END IF;
END $$;

ALTER TABLE "DepartmentSupplyRequest" ALTER COLUMN "urgency" DROP DEFAULT, ALTER COLUMN "urgency" TYPE "Priority" USING "urgency"::text::"Priority", ALTER COLUMN "urgency" SET DEFAULT 'ROUTINE';
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "SupplierContract" ADD CONSTRAINT "SupplierContract_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$');
DROP INDEX "StockReservation_idempotencyKey_key";
CREATE UNIQUE INDEX "StockReservation_facilityId_idempotencyKey_key" ON "StockReservation"("facilityId", "idempotencyKey");
DROP INDEX "StockTransfer_idempotencyKey_key";
CREATE UNIQUE INDEX "StockTransfer_facilityId_idempotencyKey_key" ON "StockTransfer"("facilityId", "idempotencyKey");
DROP INDEX "StockAdjustment_idempotencyKey_key";
CREATE UNIQUE INDEX "StockAdjustment_facilityId_idempotencyKey_key" ON "StockAdjustment"("facilityId", "idempotencyKey");
DROP INDEX "WasteRecord_idempotencyKey_key";
CREATE UNIQUE INDEX "WasteRecord_facilityId_idempotencyKey_key" ON "WasteRecord"("facilityId", "idempotencyKey");
DROP INDEX "GoodsReceipt_idempotencyKey_key";
CREATE UNIQUE INDEX "GoodsReceipt_facilityId_idempotencyKey_key" ON "GoodsReceipt"("facilityId", "idempotencyKey");
DROP INDEX "PurchaseRequisition_idempotencyKey_key";
CREATE UNIQUE INDEX "PurchaseRequisition_facilityId_idempotencyKey_key" ON "PurchaseRequisition"("facilityId", "idempotencyKey");
DROP INDEX "PurchaseOrder_idempotencyKey_key";
CREATE UNIQUE INDEX "PurchaseOrder_facilityId_idempotencyKey_key" ON "PurchaseOrder"("facilityId", "idempotencyKey");
