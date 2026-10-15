-- D1: PatientIdentifier holds only Aarogya-issued identifiers (UHID, MRN).
-- Everything issued elsewhere (ABHA number/address, insurer member IDs,
-- another hospital's MRN, legacy/other IDs) moves to ExternalIdentifier as a
-- PATIENT mapping in the patient's facility, unverified (verification is never
-- inferred). System URIs match src/lib/patient/identifiers.ts
-- (externalSystemFor / issuerSlug).

CREATE TEMP TABLE "_moved_identifier" ON COMMIT DROP AS
SELECT
  pi."id",
  p."facilityId",
  pi."patientId",
  CASE
    WHEN pi."type" IN ('ABHA', 'ABHA_ADDRESS') AND pi."value" LIKE '%@%' THEN 'https://healthid.abdm.gov.in/address'
    WHEN pi."type" IN ('ABHA', 'ABHA_NUMBER') THEN 'https://healthid.abdm.gov.in'
    WHEN pi."type" = 'INSURANCE_MEMBER_ID' THEN 'https://aarogya.local/insurer-member/'
    WHEN pi."type" = 'EXTERNAL_MRN' THEN 'https://aarogya.local/external-mrn/'
    ELSE 'https://aarogya.local/other-identifier/'
  END
  || CASE
    WHEN pi."type" IN ('ABHA', 'ABHA_NUMBER', 'ABHA_ADDRESS') THEN ''
    ELSE COALESCE(NULLIF(trim(both '-' from regexp_replace(lower(trim(COALESCE(pi."issuer", ''))), '[^a-z0-9]+', '-', 'g')), ''), 'unspecified')
  END AS "system",
  trim(pi."value") AS "value",
  CASE WHEN pi."status" IN ('ACTIVE', 'SUPERSEDED', 'REVOKED', 'INVALID') THEN pi."status" ELSE 'ACTIVE' END AS "status",
  pi."createdAt"
FROM "PatientIdentifier" pi
JOIN "Patient" p ON p."id" = pi."patientId"
WHERE pi."type" NOT IN ('UHID', 'MRN');

-- Refuse to lose data. A moved identifier that collides with an existing
-- mapping for a DIFFERENT patient (same system + value), or a patient with two
-- identifiers from one system, needs an operator's decision first.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM "_moved_identifier" m
  JOIN "ExternalIdentifier" e ON e."facilityId" = m."facilityId" AND e."system" = m."system" AND e."value" = m."value"
  WHERE NOT (e."entityType" = 'PATIENT' AND e."entityId" = m."patientId");
  IF n > 0 THEN RAISE EXCEPTION 'D1: % patient identifier(s) collide with another record''s external identifier; resolve before migrating', n; END IF;

  SELECT count(*) INTO n FROM (
    SELECT 1 FROM "_moved_identifier" GROUP BY "facilityId", "system", "value" HAVING count(DISTINCT "patientId") > 1
  ) shared;
  IF n > 0 THEN RAISE EXCEPTION 'D1: % identifier value(s) are recorded on more than one patient in a facility; resolve before migrating', n; END IF;

  SELECT count(*) INTO n FROM (
    SELECT m."facilityId", m."patientId", m."system" FROM "_moved_identifier" m
    LEFT JOIN "ExternalIdentifier" e ON e."facilityId" = m."facilityId" AND e."entityType" = 'PATIENT' AND e."entityId" = m."patientId" AND e."system" = m."system" AND e."value" = m."value"
    WHERE e."id" IS NULL
    GROUP BY 1, 2, 3
    HAVING count(*) > 1 OR EXISTS (
      SELECT 1 FROM "ExternalIdentifier" x
      WHERE x."facilityId" = m."facilityId" AND x."entityType" = 'PATIENT' AND x."entityId" = m."patientId" AND x."system" = m."system"
    )
  ) clash;
  IF n > 0 THEN RAISE EXCEPTION 'D1: % patient(s) would hold two identifiers from one system; resolve before migrating', n; END IF;
END $$;

INSERT INTO "ExternalIdentifier" (
  "id", "facilityId", "entityType", "entityId", "system", "value", "use", "status", "source",
  "verificationStatus", "retryCount", "version", "createdAt", "updatedAt"
)
SELECT m."id", m."facilityId", 'PATIENT', m."patientId", m."system", m."value", 'OFFICIAL', m."status", 'LOCAL_ENTRY',
       'UNVERIFIED', 0, 1, m."createdAt", CURRENT_TIMESTAMP
FROM "_moved_identifier" m
ON CONFLICT ("facilityId", "system", "value") DO NOTHING;

DELETE FROM "PatientIdentifier" WHERE "id" IN (SELECT "id" FROM "_moved_identifier");

ALTER TABLE "PatientIdentifier"
  ADD CONSTRAINT "PatientIdentifier_aarogya_issued_only" CHECK ("type" IN ('UHID', 'MRN'));
