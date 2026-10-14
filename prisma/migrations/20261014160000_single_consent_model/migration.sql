-- D2: InteropConsent becomes the single consent model. The old hospital
-- Consent rows (staff-recorded consents obtained offline) are copied in, then
-- the Consent table is dropped.

-- AlterTable
ALTER TABLE "InteropConsent" ADD COLUMN     "description" TEXT;

-- Backfill: each Consent becomes an InteropConsent at the patient's facility,
-- with the facility itself as recipient (a consent to be treated there), the
-- free-text scope kept as description, structured scope ALL_CLINICAL, and
-- grantedBy STAFF_RECORDED. Ids are kept, so references in audit details
-- still resolve.
INSERT INTO "InteropConsent" (
  "id", "facilityId", "patientId", "purpose", "description", "status",
  "recipientType", "recipientIdentifier", "recipientName",
  "requestedAt", "grantedAt", "expiresAt", "revokedAt", "declinedAt",
  "grantedBy", "source", "createdByStaffId", "version", "createdAt", "updatedAt"
)
SELECT
  c."id", p."facilityId", c."patientId",
  CASE c."purpose" WHEN 'TREATMENT' THEN 'TREATMENT' WHEN 'PROCEDURE' THEN 'TREATMENT' WHEN 'RESEARCH' THEN 'RESEARCH' ELSE 'OTHER' END,
  NULLIF(concat_ws(' — ', CASE WHEN c."purpose" NOT IN ('TREATMENT', 'RESEARCH') THEN c."purpose" END, c."scope"), ''),
  CASE c."status" WHEN 'GRANTED' THEN 'GRANTED' WHEN 'DENIED' THEN 'DECLINED' WHEN 'REVOKED' THEN 'REVOKED' WHEN 'EXPIRED' THEN 'EXPIRED' ELSE 'REQUESTED' END,
  'FACILITY', p."facilityId", f."name",
  c."createdAt", c."grantedAt", c."expiresAt", c."revokedAt",
  CASE WHEN c."status" = 'DENIED' THEN c."createdAt" END,
  CASE WHEN c."grantedAt" IS NOT NULL THEN 'STAFF_RECORDED' END,
  'LOCAL', c."actorStaffId", c."version", c."createdAt", CURRENT_TIMESTAMP
FROM "Consent" c
JOIN "Patient" p ON p."id" = c."patientId"
JOIN "Facility" f ON f."id" = p."facilityId";

INSERT INTO "InteropConsentScope" ("id", "consentId", "scope", "createdAt")
SELECT 'mig-' || md5(c."id"), c."id", 'ALL_CLINICAL', c."createdAt" FROM "Consent" c;

-- DropForeignKey
ALTER TABLE "Consent" DROP CONSTRAINT "Consent_actorStaffId_fkey";

-- DropForeignKey
ALTER TABLE "Consent" DROP CONSTRAINT "Consent_patientId_fkey";

-- DropTable
DROP TABLE "Consent";
