-- Phase 5 hardening: DB-level guarantee that two active Tariff rows can
-- never cover overlapping effective-date ranges for the same
-- (facilityId, chargeCode, payerId). The app-level check in pricing.ts
-- (createTariff) is necessary for a clean error message, but cannot by
-- itself close a race between two concurrent transactions that both pass
-- the overlap check before either commits. This exclusion constraint is
-- the actual guarantee — reuses the btree_gist extension already enabled
-- by the Phase 4.5 imaging-scheduling migration.
--
-- Half-open interval [effectiveFrom, effectiveTo) via tsrange with the
-- '[)' bound flag, matching pricing.ts's dateRangesOverlap semantics
-- exactly — a tariff ending exactly when another begins is NOT an overlap.
-- A NULL effectiveTo (never expires) is represented as 'infinity' for the
-- range upper bound. Only applies to active=true rows — deactivated
-- tariffs (superseded, end-dated) never block a new one from covering the
-- same period.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Tariff" ADD CONSTRAINT "tariff_no_overlap"
  EXCLUDE USING gist (
    "facilityId" WITH =,
    "chargeCode" WITH =,
    "payerId" WITH =,
    tsrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamp), '[)') WITH &&
  )
  WHERE ("active");
