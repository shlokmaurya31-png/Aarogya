-- Week 4a, step b: medicine-name reference data (versioned WHO INN imports;
-- NLEM 2022 ships in code). Additive; no rows are created here.

CREATE TYPE "MedicineReferenceSource" AS ENUM ('NLEM_2022', 'WHO_INN');
CREATE TABLE "MedicineReference" (
    "id" TEXT NOT NULL,
    "source" "MedicineReferenceSource" NOT NULL,
    "version" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MedicineReference_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MedicineReference_source_normalized_idx" ON "MedicineReference"("source", "normalized");
CREATE UNIQUE INDEX "MedicineReference_source_version_normalized_key" ON "MedicineReference"("source", "version", "normalized");

ALTER TABLE "MedicineReference" ADD CONSTRAINT "MedicineReference_nonempty_check" CHECK (length(trim("name")) > 0 AND length("normalized") > 0 AND length(trim("version")) > 0);
