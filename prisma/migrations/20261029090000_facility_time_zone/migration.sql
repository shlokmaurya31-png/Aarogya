-- Flagship 2a (pre-launch item 25): each facility's IANA time zone.
-- Additive: every existing facility is in India, which is what the schedule
-- maths assumed (through the server's TZ); the default states that explicitly.
-- The application validates the value against the runtime's zone list.
ALTER TABLE "Facility" ADD COLUMN "timeZone" TEXT NOT NULL DEFAULT 'Asia/Kolkata';
