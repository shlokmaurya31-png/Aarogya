-- D7: one source for leave and absence. StaffAbsence holds every leave,
-- holiday, blocked period and unavailability as an interval;
-- DoctorScheduleBlock holds clinic sessions only; StaffAvailability is retired.

CREATE TABLE "StaffAbsence" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3),
    "reason" TEXT,
    "recordedByStaffId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StaffAbsence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StaffAbsence_kind" CHECK ("kind" IN ('LEAVE', 'HOLIDAY', 'BLOCKED', 'UNAVAILABLE', 'OFF_DUTY', 'SUSPENDED')),
    CONSTRAINT "StaffAbsence_interval" CHECK ("endAt" IS NULL OR "endAt" > "startAt")
);
CREATE INDEX "StaffAbsence_staffId_startAt_idx" ON "StaffAbsence"("staffId", "startAt");
CREATE INDEX "StaffAbsence_facilityId_startAt_idx" ON "StaffAbsence"("facilityId", "startAt");
ALTER TABLE "StaffAbsence" ADD CONSTRAINT "StaffAbsence_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StaffAbsence" ADD CONSTRAINT "StaffAbsence_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "HospitalStaffProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Refuse to drop rows that can't be expressed: a recurring (weekly) leave or
-- block, or a session without hours. Neither ever affected booking (the slot
-- computation ignored them), but they are someone's data.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "DoctorScheduleBlock" WHERE "type" <> 'CLINIC_SESSION' AND "specificDate" IS NULL;
  IF n > 0 THEN RAISE EXCEPTION 'D7: % recurring leave/block row(s) can''t become an absence interval; resolve before migrating', n; END IF;
  SELECT count(*) INTO n FROM "DoctorScheduleBlock" WHERE "type" = 'CLINIC_SESSION' AND ("startMinute" IS NULL OR "endMinute" IS NULL);
  IF n > 0 THEN RAISE EXCEPTION 'D7: % clinic session(s) have no hours; resolve before migrating', n; END IF;
END $$;

-- Dated leave/holiday/block rows: the whole day, or the given minutes of it.
INSERT INTO "StaffAbsence" ("id", "facilityId", "staffId", "kind", "startAt", "endAt", "reason", "createdAt")
SELECT
  b."id", b."facilityId", b."staffId", b."type",
  b."specificDate" + make_interval(mins => COALESCE(b."startMinute", 0)),
  b."specificDate" + make_interval(mins => COALESCE(b."endMinute", 1440)),
  b."reason", b."createdAt"
FROM "DoctorScheduleBlock" b
WHERE b."type" <> 'CLINIC_SESSION';
DELETE FROM "DoctorScheduleBlock" WHERE "type" <> 'CLINIC_SESSION';

-- Current unavailability records (anything but AVAILABLE).
INSERT INTO "StaffAbsence" ("id", "facilityId", "staffId", "kind", "startAt", "endAt", "reason", "recordedByStaffId", "createdAt")
SELECT
  'avail-' || md5(a."id"), a."facilityId", a."staffId",
  CASE a."availability" WHEN 'ON_LEAVE' THEN 'LEAVE' ELSE a."availability" END,
  a."effectiveFrom", CASE WHEN a."effectiveTo" > a."effectiveFrom" THEN a."effectiveTo" END,
  a."reason", a."setByStaffId", a."createdAt"
FROM "StaffAvailability" a
WHERE a."availability" <> 'AVAILABLE';

DROP TABLE "StaffAvailability";

ALTER TABLE "DoctorScheduleBlock" DROP COLUMN "reason", DROP COLUMN "type",
  ALTER COLUMN "startMinute" SET NOT NULL,
  ALTER COLUMN "endMinute" SET NOT NULL;
ALTER TABLE "DoctorScheduleBlock" ADD CONSTRAINT "DoctorScheduleBlock_session" CHECK (
  ("dayOfWeek" IS NOT NULL OR "specificDate" IS NOT NULL)
  AND ("dayOfWeek" IS NULL OR "dayOfWeek" BETWEEN 0 AND 6)
  AND "startMinute" >= 0 AND "endMinute" <= 1440 AND "endMinute" > "startMinute"
);
