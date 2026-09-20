import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/auth/rbac";
import {
  requestConsent,
  grantConsent,
  revokeConsent,
  listConsents,
} from "@/lib/hospital/interoperability/consent";
import { patientLanguage as L } from "./language";
import { assertClass, type PatientAccessScope } from "../context";

/**
 * Phase D11 — patient-facing consent (brief §13, §14). Reuses the canonical
 * InteropConsent engine (purpose + scope + recipient + validity + status +
 * audit) — never a simplified `consent = true` boolean. The patient can view
 * their consents, grant (grantedBy = PATIENT), revoke, and create a new sharing
 * request. Every mutation re-verifies the consent belongs to the acting patient
 * BEFORE delegating to the engine, and only the patient themselves may act.
 */

export interface ConsentDTO {
  id: string;
  purpose: string;
  statusLabel: string;
  status: string;
  recipientType: string;
  recipientName: string | null;
  scopes: string[];
  grantedAt: string | null;
  expiresAt: string | null;
  canGrant: boolean;
  canRevoke: boolean;
}

export async function listPatientConsents(scope: PatientAccessScope): Promise<ConsentDTO[]> {
  assertClass(scope, "CONSENT");
  const consents = await listConsents({ facilityId: scope.facilityId, patientId: scope.patientId });
  return consents.map((c) => ({
    id: c.id,
    purpose: c.purpose,
    statusLabel: L.consentStatus(c.status),
    status: c.status,
    recipientType: c.recipientType,
    recipientName: c.recipientName ?? null,
    scopes: (c.scopes ?? []).map((s) => s.scope),
    grantedAt: c.grantedAt ? new Date(c.grantedAt).toISOString() : null,
    expiresAt: c.expiresAt ? new Date(c.expiresAt).toISOString() : null,
    canGrant: scope.isSelf && ["REQUESTED"].includes(c.status),
    canRevoke: scope.isSelf && ["GRANTED", "ACTIVE"].includes(c.status),
  }));
}

/** Re-verifies the consent is this patient's own before any engine call. */
async function assertOwnedConsent(scope: PatientAccessScope, consentId: string): Promise<void> {
  const c = await prisma.interopConsent.findUnique({
    where: { id: consentId },
    select: { patientId: true, facilityId: true },
  });
  if (!c || c.patientId !== scope.patientId || c.facilityId !== scope.facilityId) throw new NotFoundError();
}

export async function grantPatientConsent(scope: PatientAccessScope, actorUserId: string, consentId: string) {
  if (!scope.isSelf) throw new NotFoundError();
  await assertOwnedConsent(scope, consentId);
  return grantConsent({ facilityId: scope.facilityId, consentId, grantedBy: "PATIENT", byUserId: actorUserId });
}

export async function revokePatientConsent(scope: PatientAccessScope, actorUserId: string, consentId: string, reason?: string) {
  if (!scope.isSelf) throw new NotFoundError();
  await assertOwnedConsent(scope, consentId);
  return revokeConsent({ facilityId: scope.facilityId, consentId, reason, byUserId: actorUserId });
}

/**
 * Patient-initiated health-information sharing request. Creates the consent
 * (REQUESTED) then grants it as the patient — a patient authorizing a recipient
 * to receive a bounded class of their records until an expiry. The patient can
 * revoke it at any time.
 */
export async function createSharingRequest(
  scope: PatientAccessScope,
  actorUserId: string,
  input: { purpose: string; scopes: string[]; recipientType: string; recipientIdentifier: string; recipientName?: string; expiresAt?: string },
) {
  if (!scope.isSelf) throw new NotFoundError();
  const created = await requestConsent({
    facilityId: scope.facilityId,
    patientId: scope.patientId,
    purpose: input.purpose,
    scopes: input.scopes,
    recipientType: input.recipientType,
    recipientIdentifier: input.recipientIdentifier,
    recipientName: input.recipientName,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
    byUserId: actorUserId,
  });
  return grantConsent({ facilityId: scope.facilityId, consentId: created.id, grantedBy: "PATIENT", byUserId: actorUserId });
}
