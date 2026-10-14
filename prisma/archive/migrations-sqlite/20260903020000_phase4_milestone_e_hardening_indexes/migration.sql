-- Phase 4 Milestone E — Diagnostics Hardening
--
-- Part 1: DSL-expressible changes (mirrors what `prisma migrate diff`
-- generated for the schema.prisma edits — composite indexes for the
-- dominant facility-scoped query pattern, plus two ordinary unique
-- constraints where NULL-exemption is exactly the desired behavior).

-- CreateIndex
CREATE UNIQUE INDEX "Charge_sourceType_sourceId_key" ON "Charge"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "ImagingReport_isCritical_acknowledgedAt_isCurrent_idx" ON "ImagingReport"("isCritical", "acknowledgedAt", "isCurrent");

-- CreateIndex
CREATE INDEX "ImagingStudy_facilityId_status_idx" ON "ImagingStudy"("facilityId", "status");

-- CreateIndex
CREATE INDEX "LabResult_isCritical_acknowledgedAt_isCurrent_idx" ON "LabResult"("isCritical", "acknowledgedAt", "isCurrent");

-- CreateIndex
CREATE UNIQUE INDEX "Specimen_recollectionOfSpecimenId_key" ON "Specimen"("recollectionOfSpecimenId");

-- CreateIndex
CREATE INDEX "Specimen_facilityId_status_idx" ON "Specimen"("facilityId", "status");

-- CreateIndex
CREATE INDEX "Task_facilityId_status_idx" ON "Task"("facilityId", "status");

-- Part 2: hand-authored partial unique indexes — NOT expressible in
-- Prisma's schema.prisma DSL (no filtered/partial @@unique syntax), so
-- these exist only in migration SQL and are documented in
-- docs/PHASE_4_DIAGNOSTICS_ARCHITECTURE.md. Both SQLite and PostgreSQL
-- support `CREATE UNIQUE INDEX ... WHERE ...`; the WHERE-clause syntax
-- below is portable to Postgres unchanged (only identifier quoting is
-- already Postgres-compatible double-quotes).
--
-- Closes a CRITICAL finding: enterResult/enterReport/scheduleStudy did an
-- unconditional create with no DB constraint stopping two concurrent
-- requests from both creating a "current" row for the same order. These
-- constraints make that impossible at the database layer, not just via
-- app-level checks (which remain, catching the common case with a clean
-- error before ever reaching a raw constraint violation).

-- At most one isCurrent LabResult per (labOrderId, catalogTestId). Using
-- COALESCE(catalogTestId,'') because two NULLs are never equal in a plain
-- unique index — a naive index on (labOrderId, catalogTestId) would let
-- unlimited concurrent "current" results coexist for simple (non-panel)
-- orders, exactly where the duplicate-row race is easiest to trigger.
CREATE UNIQUE INDEX "LabResult_current_per_order_test" ON "LabResult"("labOrderId", COALESCE("catalogTestId", '')) WHERE "isCurrent" = true;

-- At most one isCurrent ImagingReport per imagingOrderId (imaging has no
-- panel-style per-test sub-identity, so no COALESCE needed here).
CREATE UNIQUE INDEX "ImagingReport_current_per_order" ON "ImagingReport"("imagingOrderId") WHERE "isCurrent" = true;

-- At most one active (non-cancelled, non-no-show) ImagingStudy per
-- imagingOrderId — matches the documented "one study per order this
-- milestone" design assumption (schema.prisma comment on ImagingOrder),
-- which the app-level TOCTOU race could previously violate.
CREATE UNIQUE INDEX "ImagingStudy_active_per_order" ON "ImagingStudy"("imagingOrderId") WHERE "status" NOT IN ('CANCELLED', 'NO_SHOW');
