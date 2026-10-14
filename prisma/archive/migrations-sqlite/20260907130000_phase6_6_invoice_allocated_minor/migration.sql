-- Phase 6.6 P0-B fix: Invoice previously had no stored allocation total —
-- allocatePayment computed it by summing PaymentAllocation rows in memory,
-- checked it once, then only CAS-guarded the Payment row. Two different
-- Payments racing the same Invoice could both pass the stale check and
-- both commit, over-allocating the invoice. allocatedMinor is now a
-- guarded running total, atomically maintained by a single conditional
-- UPDATE (allocatedMinor + amount <= totalMinor) in allocatePayment —
-- the same threshold-guarded-UPDATE idiom stockBalance.ts already uses
-- for on-hand quantity. Backfilled from existing PaymentAllocation rows
-- so no historical data is lost or misrepresented.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN "allocatedMinor" INTEGER NOT NULL DEFAULT 0;

-- Backfill from existing allocations (portable SQL — same syntax on SQLite and PostgreSQL).
UPDATE "Invoice"
SET "allocatedMinor" = COALESCE(
  (SELECT SUM("amountMinor") FROM "PaymentAllocation" WHERE "PaymentAllocation"."invoiceId" = "Invoice"."id"),
  0
);
