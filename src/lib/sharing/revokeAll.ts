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
 *
 * 4c answer (§15): consents a hospital recorded from a paper form
 * (grantedBy STAFF_RECORDED) are left alone, since the paper is the hospital's
 * record, but they are listed, before and after the tap, with how to withdraw
 * each one (paperConsentsFor).
 */
const PAPER_PURPOSE: Record<string, string> = {
  TREATMENT: "treatment", REFERRAL: "a referral", SECOND_OPINION: "a second opinion", INSURANCE: "insurance", PATIENT_ACCESS: "your own access", RESEARCH: "research", OTHER: "another purpose",
};

export interface PaperConsentDTO { id: string; facilityName: string; purpose: string; recipient: string | null; recordedAt: string; howToWithdraw: string }

/** The live consents hospitals recorded on paper for the person's linked records, each with how to withdraw it. */
export async function paperConsentsFor(personId: string): Promise<PaperConsentDTO[]> {
  const patientIds = (await prisma.personPatientLink.findMany({ where: { personId, status: "ACTIVE" }, select: { patientId: true } })).map((l) => l.patientId);
  const rows = await prisma.interopConsent.findMany({ where: { patientId: { in: patientIds }, grantedBy: { not: "PATIENT" }, status: { in: ["GRANTED", "ACTIVE"] } }, orderBy: { createdAt: "desc" } });
  const facilities = await prisma.facility.findMany({ where: { id: { in: rows.map((r) => r.facilityId) } }, select: { id: true, name: true } });
  return rows.map((r) => {
    const facilityName = facilities.find((f) => f.id === r.facilityId)?.name ?? "the hospital";
    return {
      id: r.id, facilityName, purpose: PAPER_PURPOSE[r.purpose] ?? r.purpose.toLowerCase(), recipient: r.recipientName ?? null, recordedAt: (r.grantedAt ?? r.createdAt).toISOString(),
      howToWithdraw: `This consent was signed on paper at ${facilityName}, so only the hospital can withdraw it. Ask the hospital's front desk or records office to withdraw your consent for ${PAPER_PURPOSE[r.purpose] ?? "this purpose"}, and keep the written acknowledgement they give you.`,
    };
  });
}

/** What revoke-all will do, shown before the tap. */
export async function revokeAllPreview(userId: string) {
  const personId = await requireOwnedPerson(userId);
  const patientIds = (await prisma.personPatientLink.findMany({ where: { personId, status: "ACTIVE" }, select: { patientId: true } })).map((l) => l.patientId);
  return {
    liveShares: await prisma.recordShare.count({ where: { personId, status: { in: ["PENDING", "ACTIVE"] } } }),
    pendingRequests: await prisma.accessRequest.count({ where: { personId, status: "REQUESTED" } }),
    consentsYouGave: await prisma.interopConsent.count({ where: { patientId: { in: patientIds }, grantedBy: "PATIENT", status: { in: ["GRANTED", "ACTIVE"] } } }),
    paperConsents: await paperConsentsFor(personId),
  };
}
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
  return { ...result, paperConsents: await paperConsentsFor(personId) };
}
