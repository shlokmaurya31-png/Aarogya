import { prisma } from "@/lib/db";
import { BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { requireOwnedPerson } from "@/lib/person/access";
import { recordPersonConsentTx } from "@/lib/person/consent";
import { revokeConsentTx } from "@/lib/consent/lifecycle";
import { closeSessionTx, endShareTx } from "./shares";
import { declinePendingRequestsTx } from "./requests";

/**
 * Week 4c — one-tap "revoke all" (docs/CONSENT_SHARING_DESIGN.md §7.2), in one
 * transaction, each change with its own event:
 *   1. every live share ends (REVOKE_ALL), and every open code session of the
 *      person's records with it;
 *   2. every pending access request is declined;
 *   3. every organization or interoperability consent the patient granted
 *      (grantedBy PATIENT) on a linked record is revoked;
 *   4. "share uploads with treating hospitals" becomes DECLINED if granted;
 * then PersonAccessRevokedAll with the counts. Not touched: the treating
 * hospital's own record, break-glass, and processing consents.
 */
export async function revokeAllAccess(userId: string, confirm: unknown) {
  if (confirm !== "REVOKE") throw new BadRequestError('Confirm by sending confirm: "REVOKE".');
  const personId = await requireOwnedPerson(userId);
  const result = await prisma.$transaction(async (tx) => {
    let sharesEnded = 0;
    for (const s of await tx.recordShare.findMany({ where: { personId, status: { in: ["PENDING", "ACTIVE"] } }, select: { id: true } })) {
      if (await endShareTx(tx, s.id, "REVOKED", "REVOKE_ALL", userId)) sharesEnded += 1;
    }
    const patientIds = (await tx.personPatientLink.findMany({ where: { personId, status: "ACTIVE" }, select: { patientId: true } })).map((l) => l.patientId);
    for (const s of await tx.patientAccessSession.findMany({ where: { patientId: { in: patientIds }, status: { in: ["PENDING", "ACTIVE"] } }, select: { id: true } })) {
      await closeSessionTx(tx, s.id, "PATIENT", userId);
    }
    const requestsDeclined = await declinePendingRequestsTx(tx, personId, userId);
    let consentsRevoked = 0;
    for (const c of await tx.interopConsent.findMany({ where: { patientId: { in: patientIds }, grantedBy: "PATIENT", status: { in: ["GRANTED", "ACTIVE"] } }, select: { id: true, facilityId: true } })) {
      await revokeConsentTx(tx, { facilityId: c.facilityId, consentId: c.id, reason: "PATIENT_REVOKED_ALL", byUserId: userId });
      consentsRevoked += 1;
    }
    const uploads = await tx.personConsent.findFirst({ where: { personId, purpose: "SHARE_UPLOADS_WITH_TREATING", status: "ACTIVE" }, select: { decision: true } });
    const uploadsSharingDeclined = uploads?.decision === "GRANTED";
    if (uploadsSharingDeclined) await recordPersonConsentTx(tx, { personId, userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "DECLINED", scopes: [] });
    const counts = { sharesEnded, requestsDeclined, consentsRevoked, uploadsSharingDeclined };
    await tx.personAccessLogEntry.create({ data: { personId, kind: "ACCESS_REVOKED_ALL", actorUserId: userId, detail: counts } });
    await emitDomainEvent(tx, { type: "PersonAccessRevokedAll", aggregateId: personId, personId, actorUserId: userId, payload: { personId, ...counts } });
    return counts;
  });
  await recordAuditEvent("person.access.revokedAll", userId, { personId, ...result });
  return result;
}
