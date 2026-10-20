/**
 * Week 4c — one-tap "revoke all" (docs/CONSENT_SHARING_DESIGN.md §7.2, §10). A
 * person with a redeemed code (Pune), an unredeemed code (their Noida record),
 * a share from an approved request, a pending request, a consent to the
 * organization they granted, one staff recorded offline, "share uploads with
 * treating hospitals" granted, and AI assistance granted. After revoke-all:
 *   - every share is REVOKED (REVOKE_ALL) and every code session closed, the
 *     pending request DECLINED, the patient-granted consent REVOKED, the
 *     uploads choice DECLINED — each with its own event — then
 *     PersonAccessRevokedAll with the counts, and the access log entry;
 *   - every way in returns nothing at once (the consult view, the request
 *     share, the AI);
 *   - not touched: the treating hospital's own access, the consent staff
 *     recorded offline, and the processing consent (AI assistance);
 *   - it needs the explicit confirmation, and only the person can do it;
 *   - 4c answer (§15): the paper consent is listed, before the tap and in the
 *     result, with the facility and how to withdraw it; the patient-granted
 *     one is not listed (it is revoked).
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-revoke-all.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { issueAccessCode, redeemAccessCode } from "../src/lib/patient/accessSession";
import { parseShareChoice } from "../src/lib/sharing/categories";
import { viewSharedRecord } from "../src/lib/sharing/view";
import { decideRequest, requestAccess } from "../src/lib/sharing/requests";
import { revokeAllAccess, revokeAllPreview } from "../src/lib/sharing/revokeAll";
import { decidePersonConsent } from "../src/lib/person/consent";
import { resolveAiAccess } from "../src/lib/rag/access";
import { NOIDA, PUNE, drain, eventsOf, lab, notFound, refused, reporter, sharer, staff, tag } from "./lib/shareFixture";

const { report, done } = reporter();

async function main() {
  registerAllConsumers();
  const P = await sharer({ noida: true });
  const other = await sharer();
  const puneDoc = await staff(PUNE, "DOCTOR");
  const noidaDoc = await staff(NOIDA, "DOCTOR");
  const noidaDoc2 = await staff(NOIDA, "DOCTOR");
  await lab(P.pune, P.punEnc, "Haemoglobin", `11.1 rvk${tag}`);
  await drain();

  const issued = await issueAccessCode(P.pune, P.userId, "gate", { choice: parseShareChoice({ categories: ["LABS"] }) });
  const session = (await redeemAccessCode({ code: issued.code, doctorUserId: puneDoc.userId, doctorStaffId: puneDoc.staffId, doctorName: "Gate", facilityId: PUNE }))!;
  const pending = await issueAccessCode(P.noida!, P.userId, "gate");
  const r1 = await requestAccess(noidaDoc.actor, { patientId: P.noida!, categories: ["LABS"] });
  const approved = await decideRequest(P.userId, r1.id, { decision: "APPROVE" });
  const r2 = await requestAccess(noidaDoc2.actor, { patientId: P.noida!, categories: ["LABS"] });
  const org = (await prisma.facility.findUniqueOrThrow({ where: { id: PUNE }, select: { organizationId: true } })).organizationId;
  const mine = await prisma.interopConsent.create({ data: { facilityId: PUNE, patientId: P.pune, purpose: "TREATMENT", status: "GRANTED", recipientType: "ORGANIZATION", recipientIdentifier: org, grantedAt: new Date(), grantedBy: "PATIENT", scopes: { create: [{ scope: "LAB" }] } } });
  const paper = await prisma.interopConsent.create({ data: { facilityId: PUNE, patientId: P.pune, purpose: "TREATMENT", status: "GRANTED", recipientType: "ORGANIZATION", recipientIdentifier: org, grantedAt: new Date(), grantedBy: "STAFF_RECORDED", scopes: { create: [{ scope: "LAB" }] } } });
  await decidePersonConsent({ userId: P.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED" });
  await decidePersonConsent({ userId: P.userId, purpose: "AI_ASSISTANCE", decision: "GRANTED" });
  report("Before: the doctor reads the code's share, and the Noida doctor the request's", JSON.stringify((await viewSharedRecord(puneDoc.actor, session.id, "CONSULT_VIEW")).history).includes(`rvk${tag}`)
    && JSON.stringify((await viewSharedRecord(noidaDoc.actor, approved.shareId!, "SHARED_RECORD_VIEW")).history).includes(`rvk${tag}`));

  report("Revoke-all needs the explicit confirmation", await refused(revokeAllAccess(P.userId, "yes")));
  report("Only the person's own login reaches their shares (another person's revoke-all leaves them alone)", (await revokeAllAccess(other.userId, "REVOKE")).sharesEnded === 0
    && (await prisma.recordShare.findUniqueOrThrow({ where: { id: approved.shareId! } })).status === "ACTIVE");
  const preview = await revokeAllPreview(P.userId);
  const puneName = (await prisma.facility.findUniqueOrThrow({ where: { id: PUNE }, select: { name: true } })).name;
  report("Before the tap: the preview lists the paper consent with its facility and how to withdraw it, and not the one the patient gave",
    preview.paperConsents.length === 1 && preview.paperConsents[0].id === paper.id && preview.paperConsents[0].facilityName === puneName && /withdraw/i.test(preview.paperConsents[0].howToWithdraw) && preview.consentsYouGave === 1);
  const res = await revokeAllAccess(P.userId, "REVOKE");
  report("After the tap: the result lists the paper consent it left, with the instructions", res.paperConsents.length === 1 && res.paperConsents[0].id === paper.id && res.paperConsents[0].howToWithdraw.includes(puneName));
  report("The counts: three shares, one request, one consent, the uploads choice", res.sharesEnded === 3 && res.requestsDeclined === 1 && res.consentsRevoked === 1 && res.uploadsSharingDeclined, JSON.stringify(res));
  const shares = await prisma.recordShare.findMany({ where: { personId: P.personId } });
  report("Every share is REVOKED (REVOKE_ALL), each with its event", shares.length === 3 && shares.every((s) => s.status === "REVOKED" && s.endedReason === "REVOKE_ALL")
    && (await Promise.all(shares.map((s) => eventsOf(s.id, "RecordShareStatusChanged")))).every((evs) => evs.some((e) => (e.payload as { endedReason?: string }).endedReason === "REVOKE_ALL")));
  const sessions = await prisma.patientAccessSession.findMany({ where: { id: { in: [session.id, pending.session.id] } } });
  report("The live visit is ENDED and the unredeemed code CANCELLED", sessions.find((s) => s.id === session.id)?.status === "ENDED" && sessions.find((s) => s.id === pending.session.id)?.status === "CANCELLED");
  report("…the visit's end has its session event too", (await eventsOf(session.id, "PatientAccessSessionStatusChanged")).some((e) => (e.payload as { to?: string }).to === "ENDED"));
  report("The pending request is DECLINED, with its event", (await prisma.accessRequest.findUniqueOrThrow({ where: { id: r2.id } })).status === "DECLINED" && (await eventsOf(r2.id, "AccessRequestStatusChanged")).length === 1);
  report("The consent the patient granted is REVOKED, with ConsentRevoked", (await prisma.interopConsent.findUniqueOrThrow({ where: { id: mine.id } })).status === "REVOKED" && (await eventsOf(mine.id, "ConsentRevoked")).length === 1);
  report("The consent staff recorded offline is untouched", (await prisma.interopConsent.findUniqueOrThrow({ where: { id: paper.id } })).status === "GRANTED");
  const uploads = await prisma.personConsent.findFirstOrThrow({ where: { personId: P.personId, purpose: "SHARE_UPLOADS_WITH_TREATING", status: "ACTIVE" } });
  report("Sharing uploads with treating hospitals is DECLINED, with PersonConsentDecided", uploads.decision === "DECLINED" && (await prisma.domainEventOutbox.count({ where: { personId: P.personId, eventType: "PersonConsentDecided" } })) === 3);
  report("AI assistance (a processing consent) is untouched", (await prisma.personConsent.findFirstOrThrow({ where: { personId: P.personId, purpose: "AI_ASSISTANCE", status: "ACTIVE" } })).decision === "GRANTED");
  const all = await prisma.domainEventOutbox.findMany({ where: { aggregateId: P.personId, eventType: "PersonAccessRevokedAll" } });
  report("PersonAccessRevokedAll with the counts, and the access-log entry", all.length === 1 && (all[0].payload as { sharesEnded?: number }).sharesEnded === 3 && (await prisma.personAccessLogEntry.count({ where: { personId: P.personId, kind: "ACCESS_REVOKED_ALL" } })) === 1);

  report("At once: the consult view is gone (404)", await notFound(viewSharedRecord(puneDoc.actor, session.id, "CONSULT_VIEW")));
  report("…the request share is gone (404)", await notFound(viewSharedRecord(noidaDoc.actor, approved.shareId!, "SHARED_RECORD_VIEW")));
  report("…the AI through either is a 404", await refused(resolveAiAccess({ kind: "STAFF", userId: noidaDoc.userId, role: "DOCTOR", facilityId: NOIDA }, { mode: "CHART_QA", patientId: P.noida!, shareId: approved.shareId! })));
  const treating = await resolveAiAccess({ kind: "STAFF", userId: puneDoc.userId, role: "DOCTOR", facilityId: PUNE }, { mode: "CHART_QA", patientId: P.pune });
  report("The treating hospital's own access is unaffected (its record; the uploads no longer)", treating.path === "TREATING" && !treating.scope.segments.some((s) => s.personId));
  report("A second revoke-all finds nothing more to end", (await revokeAllAccess(P.userId, "REVOKE")).sharesEnded === 0);

  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
