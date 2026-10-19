/**
 * Week 4c — access requests (docs/CONSENT_SHARING_DESIGN.md §5, §8, §10):
 *   - only a doctor (as themselves) or a facility admin (as the facility) at
 *     a facility holding an ACTIVE link to the person can ask; anyone else,
 *     or about anyone else, gets a 404; a request can't ask for sensitive
 *     categories; one open request per requester and person;
 *   - the person sees who asks and what for; approving narrower creates the
 *     share with exactly the narrower scope (more categories or a wider
 *     period is refused); declining, cancelling and expiry each end it;
 *   - through an approved request, the Noida doctor reads the person's Pune
 *     record (the share's categories only), in the view and the AI; another
 *     Noida doctor doesn't; a facility recipient reads only while it treats
 *     the person;
 *   - every transition emits its event and is in the person's access log.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-access-requests.ts
 */
import { randomBytes } from "node:crypto";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { cancelRequest, decideRequest, listFacilityRequests, listOwnRequests, requestAccess, sweepAccessRequestExpiry } from "../src/lib/sharing/requests";
import { viewSharedRecord } from "../src/lib/sharing/view";
import { askAi } from "../src/lib/rag/ask";
import { NOIDA, PUNE, drain, eventsOf, lab, medicine, notFound, refused, reporter, sharer, staff, tag } from "./lib/shareFixture";

const { report, done } = reporter();
process.env.AI_TEXT_KEY_VERSION = "1";
process.env.AI_TEXT_KEY_1 = randomBytes(32).toString("base64");

async function main() {
  registerAllConsumers();
  const P = await sharer({ noida: true });
  const stranger = await sharer();
  const noidaDoc = await staff(NOIDA, "DOCTOR");
  const noidaDoc2 = await staff(NOIDA, "DOCTOR");
  const noidaAdmin = await staff(NOIDA, "HOSPITAL_ADMIN");
  const noidaNurse = await staff(NOIDA, "NURSE");
  const puneDoc = await staff(PUNE, "DOCTOR");
  await lab(P.pune, P.punEnc, "Haemoglobin", `10.9 punelab${tag}`);
  await medicine(P.pune, P.punEnc, `Telmisartan punerx${tag}`);
  await drain();
  const ask = (actor: typeof noidaDoc.actor, body: Record<string, unknown>) => requestAccess(actor, body);

  // 1. Who may ask.
  report("A Noida doctor can't ask about a patient Noida doesn't hold (404)", await notFound(ask(noidaDoc.actor, { patientId: stranger.pune, categories: ["LABS"] })));
  report("A Pune doctor can't ask through Noida's record (404)", await notFound(ask(puneDoc.actor, { patientId: P.noida!, categories: ["LABS"] })));
  report("A nurse can't ask", await refused(ask(noidaNurse.actor, { patientId: P.noida!, categories: ["LABS"] })));
  report("A doctor can't ask as the facility", await refused(ask(noidaDoc.actor, { patientId: P.noida!, requesterKind: "FACILITY", categories: ["LABS"], purpose: "REFERRAL" })));
  report("A request can't ask for a sensitive category", await refused(ask(noidaDoc.actor, { patientId: P.noida!, categories: ["LABS"], sensitiveCategories: ["HIV"] })));
  report("A request needs at least one category", await refused(ask(noidaDoc.actor, { patientId: P.noida!, categories: [] })));
  const r1 = await ask(noidaDoc.actor, { patientId: P.noida!, categories: ["LABS", "PRESCRIPTIONS"], purpose: "SECOND_OPINION", reason: "Second opinion on anaemia", period: { from: "2026-01-01" } });
  report("A Noida doctor asks about their own patient: REQUESTED, 7 days to decide", r1.status === "REQUESTED" && Math.abs(new Date(r1.expiresAt).getTime() - Date.now() - 7 * 86_400_000) < 60_000);
  report("…with AccessRequested and ACCESS_REQUESTED in the person's log", (await eventsOf(r1.id, "AccessRequested")).length === 1 && (await prisma.personAccessLogEntry.count({ where: { personId: P.personId, kind: "ACCESS_REQUESTED" } })) === 1);
  report("A second open request by the same doctor is refused", await refused(ask(noidaDoc.actor, { patientId: P.noida!, categories: ["LABS"] })));
  const mine = await listOwnRequests(P.userId);
  const seen = mine.find((r) => r.id === r1.id);
  const docName = (await prisma.user.findUniqueOrThrow({ where: { id: noidaDoc.userId }, select: { displayName: true } })).displayName;
  const noidaName = (await prisma.facility.findUniqueOrThrow({ where: { id: NOIDA }, select: { name: true } })).name;
  report("The person sees who asks, from where, for what and why", !!seen && seen.requesterName === docName && seen.facilityName === noidaName && seen.categories.join() === "LABS,PRESCRIPTIONS" && seen.reason === "Second opinion on anaemia");
  report("Someone else can't decide it (404)", await notFound(decideRequest(stranger.userId, r1.id, { decision: "APPROVE" })));

  // 2. Approve narrower.
  report("Approving more categories than asked is refused", await refused(decideRequest(P.userId, r1.id, { decision: "APPROVE", categories: ["LABS", "IMAGING"] })));
  report("Approving a wider period than asked is refused", await refused(decideRequest(P.userId, r1.id, { decision: "APPROVE", categories: ["LABS"], period: { from: "2020-01-01" } })));
  const d1 = await decideRequest(P.userId, r1.id, { decision: "APPROVE", categories: ["LABS"], validDays: 10 });
  const share = await prisma.recordShare.findUniqueOrThrow({ where: { id: d1.shareId! } });
  report("Approving narrower: a REQUEST share, ACTIVE, LABS only, the asked period kept, bound to the doctor at Noida, valid 10 days",
    share.kind === "REQUEST" && share.status === "ACTIVE" && share.categories.join() === "LABS" && share.recordedFrom?.toISOString().slice(0, 10) === "2026-01-01" && share.recipientUserId === noidaDoc.userId && share.recipientFacilityId === NOIDA
      && Math.abs(share.expiresAt.getTime() - Date.now() - 10 * 86_400_000) < 60_000 && share.patientIds.includes(P.pune) && share.patientIds.includes(P.noida!));
  report("…with AccessRequestStatusChanged (APPROVED, naming the share) and RecordShareCreated",
    (await eventsOf(r1.id, "AccessRequestStatusChanged")).some((e) => (e.payload as { to?: string; shareId?: string }).to === "APPROVED" && (e.payload as { shareId?: string }).shareId === share.id) && (await eventsOf(share.id, "RecordShareCreated")).length === 1);
  report("A decided request can't be decided again", await refused(decideRequest(P.userId, r1.id, { decision: "DECLINE" })));

  // 3. Reading through it.
  const v = (await viewSharedRecord(noidaDoc.actor, share.id, "SHARED_RECORD_VIEW")).history;
  report("The Noida doctor reads the person's Pune lab result through the share", JSON.stringify(v.labResults).includes(`punelab${tag}`));
  report("…and not the medicine (PRESCRIPTIONS wasn't approved)", v.medicationOrders === undefined && !JSON.stringify(v).includes(`punerx${tag}`));
  report("…and the read is in the person's log, by way of the request", (await prisma.personAccessLogEntry.count({ where: { personId: P.personId, kind: "RECORD_ACCESSED", actorUserId: noidaDoc.userId, detail: { path: ["via"], equals: "ACCESS_REQUEST" } } })) === 1);
  report("Another Noida doctor reads nothing through it (404)", await notFound(viewSharedRecord(noidaDoc2.actor, share.id, "SHARED_RECORD_VIEW")));
  report("A Pune doctor reads nothing through it (404)", await notFound(viewSharedRecord(puneDoc.actor, share.id, "SHARED_RECORD_VIEW")));
  const ai = await askAi({ kind: "STAFF", userId: noidaDoc.userId, role: "DOCTOR", facilityId: NOIDA }, { mode: "CHART_QA", patientId: P.noida!, shareId: share.id, question: "What was the haemoglobin?" });
  report("The AI through the request share answers from the Pune lab result", ai.outcome === "ANSWERED" && JSON.stringify(ai.sentences).includes(`punelab${tag}`) && !JSON.stringify(ai).includes(`punerx${tag}`));
  const asked = await listFacilityRequests(noidaDoc.actor);
  report("The requester sees the request approved, with the share to open", asked.some((r) => r.id === r1.id && r.status === "APPROVED" && r.share?.id === share.id));

  // 4. Decline, cancel, expire.
  const r2 = await ask(noidaDoc2.actor, { patientId: P.noida!, categories: ["IMAGING"] });
  await decideRequest(P.userId, r2.id, { decision: "DECLINE" });
  report("Declining: DECLINED, with its event, and no share", (await prisma.accessRequest.findUniqueOrThrow({ where: { id: r2.id } })).status === "DECLINED" && (await prisma.recordShare.count({ where: { accessRequestId: r2.id } })) === 0 && (await eventsOf(r2.id, "AccessRequestStatusChanged")).length === 1);
  const r3 = await ask(noidaDoc2.actor, { patientId: P.noida!, categories: ["LABS"] });
  report("Only the requester can cancel (404 for another doctor)", await notFound(cancelRequest(noidaDoc.actor, r3.id)));
  await cancelRequest(noidaDoc2.actor, r3.id);
  report("Cancelling: CANCELLED, with its event", (await prisma.accessRequest.findUniqueOrThrow({ where: { id: r3.id } })).status === "CANCELLED" && (await eventsOf(r3.id, "AccessRequestStatusChanged")).length === 1);
  const r4 = await ask(noidaDoc2.actor, { patientId: P.noida!, categories: ["LABS"] });
  await prisma.accessRequest.update({ where: { id: r4.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  report("An expired request can't be approved", await refused(decideRequest(P.userId, r4.id, { decision: "APPROVE" })));
  const swept = await sweepAccessRequestExpiry();
  report("The sweep expires it (EXPIRED), with its event", swept.expired >= 1 && (await prisma.accessRequest.findUniqueOrThrow({ where: { id: r4.id } })).status === "EXPIRED" && (await eventsOf(r4.id, "AccessRequestStatusChanged")).length === 1);

  // 5. A facility recipient.
  const r5 = await ask(noidaAdmin.actor, { patientId: P.noida!, requesterKind: "FACILITY", categories: ["LABS"], purpose: "REFERRAL" });
  const d5 = await decideRequest(P.userId, r5.id, { decision: "APPROVE" });
  const s5 = await prisma.recordShare.findUniqueOrThrow({ where: { id: d5.shareId! } });
  report("A facility request's share names the facility, not a doctor", s5.recipientUserId === null && s5.recipientFacilityId === NOIDA);
  report("A Noida doctor reads through it while Noida treats the person", JSON.stringify((await viewSharedRecord(noidaDoc2.actor, s5.id, "SHARED_RECORD_VIEW")).history.labResults).includes(`punelab${tag}`));
  report("The admin who asked (not a doctor) reads nothing (404)", await notFound(viewSharedRecord(noidaAdmin.actor, s5.id, "SHARED_RECORD_VIEW")));
  await prisma.encounter.update({ where: { id: P.noidaEnc! }, data: { status: "CLOSED", closedAt: new Date(Date.now() - 400 * 86_400_000), registeredAt: new Date(Date.now() - 401 * 86_400_000) } });
  report("Once Noida no longer treats the person, its doctors read nothing through it (404)", await notFound(viewSharedRecord(noidaDoc2.actor, s5.id, "SHARED_RECORD_VIEW")));
  report("A facility can't ask with purpose OTHER", await refused(ask(noidaAdmin.actor, { patientId: P.noida!, requesterKind: "FACILITY", categories: ["LABS"], purpose: "OTHER" })));

  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
