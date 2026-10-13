-- Prisma Migrate's shadow database (SHADOW_DATABASE_URL). Prisma creates and
-- drops schema objects in it to detect drift, so it must be a separate,
-- disposable database owned by the app user.
-- Only runs when the data volume is first initialised.
CREATE DATABASE aarogya_shadow OWNER aarogya;
