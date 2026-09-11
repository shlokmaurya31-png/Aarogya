-- Phase B final integration gate — integrity hardening. Additive only; no
-- table is rebuilt and no data is destroyed.
--
-- 1. staff_shift_no_overlap
--    Phase B10 guarded roster overlap with a findFirst() inside the
--    transaction plus a @@unique([staffId, startAt]). The unique index only
--    catches two shifts that start at the exact same instant; two genuinely
--    overlapping shifts with different starts (08:00-16:00 and 12:00-20:00)
--    both pass the findFirst check under concurrency and both commit, because
--    READ COMMITTED does not make that read-then-write atomic. This is the
--    same class of race B3 solved for theatres and B1 for imaging resources,
--    so it gets the same race-proof answer: a GiST exclusion constraint, which
--    is enforced by the database itself and cannot be lost to interleaving.
--    SQLite cannot express EXCLUDE, so on SQLite the in-service transactional
--    check remains the (single-writer, therefore adequate) guard — see
--    docs/HOSPITAL_THREAT_MODEL.md and the gate report §33.
--
-- 2. Bed_icuUnitId_idx
--    Declared in schema.prisma by this gate so the Postgres database, the
--    SQLite tree and the Prisma schema finally agree. The index already exists
--    in Postgres (created by the B1 ICU migration) but was absent from both
--    schema.prisma and the SQLite tree, which made `migrate diff` report
--    permanent drift and would have had the next `migrate dev` silently emit a
--    DROP INDEX. IF NOT EXISTS makes this a no-op on databases that have it.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "StaffShift" ADD CONSTRAINT "staff_shift_no_overlap"
  EXCLUDE USING gist (
    "staffId" WITH =,
    tsrange("startAt", "endAt", '[)') WITH &&
  )
  WHERE ("status" = 'SCHEDULED');

CREATE INDEX IF NOT EXISTS "Bed_icuUnitId_idx" ON "Bed"("icuUnitId");
