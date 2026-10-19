-- Week 4b (4a follow-up b): the record-level allergy status, as history
-- (NO_KNOWN_ALLERGIES | UNKNOWN | HAS_ALLERGIES). Additive: no row is
-- backfilled. A record with no entry reads as UNKNOWN (or HAS_ALLERGIES when
-- it has an active allergy); "no known allergies" is never inferred.

-- CreateEnum
CREATE TYPE "AllergyStatusAssertion" AS ENUM ('NO_KNOWN_ALLERGIES', 'UNKNOWN', 'HAS_ALLERGIES');

-- CreateEnum
CREATE TYPE "AllergyStatusChangeReason" AS ENUM ('RECORDED', 'ALLERGY_ADDED', 'LAST_ALLERGY_INACTIVATED');

-- CreateTable
CREATE TABLE "AllergyStatusEntry" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "status" "AllergyStatusAssertion" NOT NULL,
    "previousStatus" "AllergyStatusAssertion",
    "reason" "AllergyStatusChangeReason" NOT NULL,
    "recordedByUserId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sequence" INTEGER NOT NULL,

    CONSTRAINT "AllergyStatusEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AllergyStatusEntry_patientId_sequence_key" ON "AllergyStatusEntry"("patientId", "sequence");

-- CreateIndex
CREATE INDEX "AllergyStatusEntry_facilityId_idx" ON "AllergyStatusEntry"("facilityId");

-- AddForeignKey
ALTER TABLE "AllergyStatusEntry" ADD CONSTRAINT "AllergyStatusEntry_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AllergyStatusEntry" ADD CONSTRAINT "AllergyStatusEntry_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The entry's facility is its patient's facility.
CREATE FUNCTION "AllergyStatusEntry_facility_matches"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Patient" p WHERE p."id" = NEW."patientId" AND p."facilityId" = NEW."facilityId") THEN
    RAISE EXCEPTION 'AllergyStatusEntry.facilityId must equal the patient''s facility' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AllergyStatusEntry_facility_matches_trg" BEFORE INSERT ON "AllergyStatusEntry"
  FOR EACH ROW EXECUTE FUNCTION "AllergyStatusEntry_facility_matches"();

-- History is append-only.
CREATE FUNCTION "AllergyStatusEntry_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AllergyStatusEntry is append-only' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AllergyStatusEntry_append_only_trg" BEFORE UPDATE OR DELETE ON "AllergyStatusEntry"
  FOR EACH ROW EXECUTE FUNCTION "AllergyStatusEntry_append_only"();

-- A change records where it came from.
ALTER TABLE "AllergyStatusEntry" ADD CONSTRAINT "AllergyStatusEntry_changed_check"
  CHECK ("previousStatus" IS DISTINCT FROM "status");
ALTER TABLE "AllergyStatusEntry" ADD CONSTRAINT "AllergyStatusEntry_sequence_check"
  CHECK ("sequence" >= 1);
