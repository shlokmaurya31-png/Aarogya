-- 4c fix: three more share categories. Additive: existing shares keep exactly
-- the categories they were given; nothing is backfilled.
ALTER TYPE "ShareCategory" ADD VALUE 'CONDITIONS';
ALTER TYPE "ShareCategory" ADD VALUE 'VITALS';
ALTER TYPE "ShareCategory" ADD VALUE 'CLINICAL_NOTES';
