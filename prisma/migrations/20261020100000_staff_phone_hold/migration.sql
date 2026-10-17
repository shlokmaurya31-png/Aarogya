-- Phase 0, part 2 (a): insider-takeover fix. A phone set or changed by staff
-- can't receive a link code for identity.staff_phone_hold_days (default 7);
-- only two-staff in-person verification links during that hold. Additive:
-- existing rows have no staff phone change recorded (NULL), so no hold.

ALTER TYPE "PersonInPersonReason" ADD VALUE 'PHONE_RECENTLY_CHANGED';
ALTER TABLE "Patient" ADD COLUMN     "phoneSetByStaffAt" TIMESTAMP(3);
