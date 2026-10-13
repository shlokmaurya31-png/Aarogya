-- Phase B final integration gate — integrity hardening (SQLite tree).
-- Mirrors prisma/migrations-postgres-baseline/20260911120000_phase_b_gate_integrity.
--
-- Only the Bed_icuUnitId_idx index is portable. The staff_shift_no_overlap
-- EXCLUDE constraint in the Postgres baseline has no SQLite equivalent:
-- SQLite has neither GiST nor exclusion constraints. That is an accepted and
-- documented engine difference (gate §33) rather than something to work around
-- — SQLite serializes writers, so the in-service transactional overlap check in
-- src/lib/hospital/workforce/service.ts is sufficient there, while PostgreSQL
-- (which permits genuine write concurrency) needs the database-level guarantee.
-- The production safeguard is deliberately NOT removed to make the two engines
-- look identical.

CREATE INDEX IF NOT EXISTS "Bed_icuUnitId_idx" ON "Bed"("icuUnitId");
