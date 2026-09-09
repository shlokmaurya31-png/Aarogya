-- Phase 6.8 EMPI + ADT: admission context (Admission.admissionType) and
-- discharge context (Discharge.dischargeType). Both nullable, additive.
-- Mirrors prisma/migrations/20260909002605_phase6_8_empi_adt (the SQLite dev
-- migration) — same columns, portable SQL.

-- AlterTable
ALTER TABLE "Admission" ADD COLUMN "admissionType" TEXT;

-- AlterTable
ALTER TABLE "Discharge" ADD COLUMN "dischargeType" TEXT;
