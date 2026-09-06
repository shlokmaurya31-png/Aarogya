-- Phase 4.5 hardening: DB-level guarantee that two active ImagingStudy
-- bookings for the same resource can never occupy overlapping scheduled
-- intervals. The app-level check in imagingStudyLifecycle.ts (count of
-- overlapping rows before create/update) is necessary for a clean error
-- message, but cannot by itself close a race between two concurrent
-- transactions that both pass the count check before either commits.
-- This exclusion constraint is the actual guarantee; Prisma's schema DSL
-- cannot express EXCLUDE constraints, hence raw SQL.
--
-- Half-open interval [scheduledAt, scheduledEndAt) via tsrange with the
-- '[)' bound flag — matches the app-level query's `lt`/`gt` semantics, so
-- adjacent bookings (10:00-10:30 then 10:30-11:00) are allowed.
-- Only applies to rows with a resourceId and a non-cancelled status —
-- cancelled/no-show studies free the resource for reuse.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "ImagingStudy" ADD CONSTRAINT "imaging_resource_no_overlap"
  EXCLUDE USING gist (
    "resourceId" WITH =,
    tsrange("scheduledAt", "scheduledEndAt", '[)') WITH &&
  )
  WHERE ("resourceId" IS NOT NULL AND "status" NOT IN ('CANCELLED', 'NO_SHOW'));
