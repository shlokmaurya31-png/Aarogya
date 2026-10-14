-- Phase 6.9 EMR + Documents: non-destructive clinical-document versioning.
-- Additive columns only (Postgres supports ADD COLUMN directly; the SQLite
-- dev migration rebuilds the table because SQLite lacks in-place ADD COLUMN
-- for some cases, but the resulting shape is identical). Mirrors
-- prisma/migrations/20260909033501_phase6_9_document_versioning.

-- AlterTable
ALTER TABLE "ClinicalDocument" ADD COLUMN "supersedesId" TEXT;

-- AlterTable
ALTER TABLE "ClinicalDocument" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'CURRENT';
