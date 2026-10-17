-- Disposable databases next to the dev database (aarogya). Both are owned by
-- the app user. Only runs when the data volume is first initialised; on an
-- older volume, `prisma migrate reset` creates aarogya_verify on first use.

-- Prisma Migrate's shadow database (SHADOW_DATABASE_URL). Prisma creates and
-- drops schema objects in it to detect drift, so it must be a separate,
-- disposable database.
CREATE DATABASE aarogya_shadow OWNER aarogya;

-- The integrity gates' database (VERIFY_DATABASE_URL). `npm run verify:all`
-- resets, migrates and seeds it on every run; it never touches aarogya.
CREATE DATABASE aarogya_verify OWNER aarogya;
