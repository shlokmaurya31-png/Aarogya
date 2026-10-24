/**
 * Week 5c — pre-arrival check-in (docs/PATIENT_INSURANCE_DESIGN.md §3, §4, §14):
 *   - the window: opens 24 hours before a booked visit or a planned admission,
 *     closes 1 hour before; someone else's visit is a 404;
 *   - submitting: the details confirmed (or a mismatch to the desk), a card
 *     (a card share for this facility, this visit) or "I'll pay myself", an
 *     optional CHECKIN share for the visit's doctor (another doctor can't
 *     read it), a token; once per visit; events in the same transaction;
 *   - it never waits for the insurer: eligibility PENDING, the desk can mark
 *     it READY and the patient arrive; staff verification creates the
 *     facility's coverage with sourceCardId (CoverageVerifiedFromCard), or
 *     sends the patient to the desk;
 *   - the desk sees them pre-registered; arrival runs the existing check-in
 *     (PatientCheckedIn) and a READY patient goes straight to the doctor's
 *     queue, a NEEDS_DESK one to registration;
 *   - a cancelled or missed visit lapses the check-in and ends its shares;
 *     the patient can cancel; a stale one lapses by the sweep;
 *   - proxies: BOOK checks a member in; a card needs INSURANCE too;
 *   - "check-in is open" is told once.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-pre-arrival.ts
 */
import "./lib/gateBootstrap";
process.env.SMS_PROVIDER = "outbox";
process.env.EMAIL_PROVIDER = "outbox";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { addCard } from "../src/lib/insurance/cards";
import { cancelPreArrival, checkInOptions, deskDecide, markArrived, preRegistered, submitPreArrival, sweepStaleCheckIns } from "../src/lib/insurance/checkin";
import { verifyCheckInCard } from "../src/lib/insurance/cardShares";
import { sweepCheckInOpen } from "../src/lib/insurance/notify";
import { cancelAppointment, markNoShow } from "../src/lib/hospital/appointment";
import { createAdmissionRequest } from "../src/lib/hospital/admissionRequest";
import { viewSharedRecord } from "../src/lib/sharing/view";
import { istDay } from "../src/lib/person/notifications";
import { PUNE, drain, eventsOf, notFound, refused, reporter, sharer, staff, tag } from "./lib/shareFixture";
import { child, manager } from "./lib/householdFixture";
import { INSURER, appointmentIn, cardKeyForRun } from "./lib/insuranceFixture";

const { report, done } = reporter();

async function main() {
  registerAllConsumers();
  cardKeyForRun();
  const doc = await staff(PUNE, "DOCTOR");
  const doc2 = await staff(PUNE, "DOCTOR");
  const desk = await staff(PUNE, "HOSPITAL_ADMIN");
  const P = await sharer();
  const me = { userId: P.userId };
  const card = await addCard(me, { payerType: "PRIVATE_INSURER", payerId: INSURER, memberId: `PRE${tag.toUpperCase()}AB12` });
  const rec = { patientId: P.pune, facilityId: PUNE, doctorStaffId: doc.staffId };

  // 1. The window.
  const early = await appointmentIn(rec, 30);
  const late = await appointmentIn(rec, 0.5);
  const a1 = await appointmentIn(rec, 5);
  const ok = { detailsConfirmed: true, cardId: card.id, share: { categories: ["LABS"] } };
  report("Too early (30 hours ahead): refused", await refused(submitPreArrival(me, { appointmentId: early.id, ...ok })));
  report("Too late (half an hour ahead): refused", await refused(submitPreArrival(me, { appointmentId: late.id, ...ok })));
  const opts = await checkInOptions(me, { appointmentId: a1.id });
  report("Five hours ahead: open, with the facility's details to confirm (phone masked) and the cards", opts.visit.open && !!opts.details.uhid && opts.cards.some((c) => c.id === card.id) && !JSON.stringify(opts.cards).includes(`PRE${tag.toUpperCase()}AB12`));
  const other = await sharer();
  report("Someone else's visit: 404", await notFound(submitPreArrival({ userId: other.userId }, { appointmentId: a1.id, detailsConfirmed: true, selfPay: true })));
  report("Details must be confirmed or flagged", await refused(submitPreArrival(me, { appointmentId: a1.id, cardId: card.id })));
  report("A card or 'I'll pay myself' is required", await refused(submitPreArrival(me, { appointmentId: a1.id, detailsConfirmed: true })));

  // 2. Submitting.
  const ci = await submitPreArrival(me, { appointmentId: a1.id, ...ok });
  const row = await prisma.preArrivalCheckIn.findUniqueOrThrow({ where: { id: ci.id } });
  report("Submitted: a token, eligibility PENDING (the insurer isn't waited for)", ci.status === "SUBMITTED" && /^P-\d{3}$/.test(ci.token) && ci.eligibility === "PENDING" && ci.eligibilityText.startsWith("Eligibility pending"));
  const cs = await prisma.cardShare.findUniqueOrThrow({ where: { id: row.cardShareId! } });
  report("…the card shared with this facility for this visit (until 2 days after)", cs.status === "ACTIVE" && cs.recipientFacilityId === PUNE && cs.cardId === card.id && cs.checkInId === ci.id && cs.expiresAt > a1.scheduledEnd);
  const share = await prisma.recordShare.findUniqueOrThrow({ where: { id: row.shareId! } });
  report("…a CHECKIN share for the visit's doctor, LABS only", share.kind === "CHECKIN" && share.status === "ACTIVE" && share.recipientUserId === doc.userId && share.recipientFacilityId === PUNE && share.categories.join() === "LABS");
  report("…events: PreArrivalCheckInSubmitted, CardShareStatusChanged, RecordShareCreated v3 (CHECKIN)",
    (await eventsOf(ci.id, "PreArrivalCheckInSubmitted")).length === 1 && (await eventsOf(cs.id, "CardShareStatusChanged")).length === 1 && (await eventsOf(share.id, "RecordShareCreated")).some((e) => e.eventVersion === 3 && (e.payload as { kind?: string }).kind === "CHECKIN"));
  report("Once per visit", await refused(submitPreArrival(me, { appointmentId: a1.id, ...ok })));
  report("The visit's doctor reads the check-in share", !!(await viewSharedRecord({ userId: doc.userId, facilityId: PUNE, role: "DOCTOR" }, share.id, "SHARED_RECORD_VIEW")));
  report("…another doctor can't (404)", await notFound(viewSharedRecord({ userId: doc2.userId, facilityId: PUNE, role: "DOCTOR" }, share.id, "SHARED_RECORD_VIEW")));

  // 3. The desk.
  const list = await preRegistered(PUNE, istDay(a1.scheduledStart).day);
  const mine = list.checkIns.find((x) => x.id === ci.id);
  report("The desk sees the patient pre-registered: token, eligibility pending, a card", !!mine && mine.token === ci.token && mine.eligibility === "PENDING" && mine.hasCard && mine.uhid.length > 0);
  const ready = await deskDecide({ userId: desk.userId, facilityId: PUNE }, ci.id, { status: "READY" });
  report("READY without waiting for the insurer", ready.status === "READY" && ready.eligibility === "PENDING");
  const v = await verifyCheckInCard({ userId: desk.userId, facilityId: PUNE }, ci.id, { outcome: "VERIFIED" });
  const cov = await prisma.patientCoverage.findUniqueOrThrow({ where: { id: v.coverageId! } });
  report("Staff verify the card: the facility's coverage, with sourceCardId", v.eligibility === "VERIFIED" && cov.sourceCardId === card.id && cov.patientId === P.pune && cov.payerId === INSURER);
  report("…CoverageVerifiedFromCard and CoverageStatusChanged", (await eventsOf(ci.id, "CoverageVerifiedFromCard")).length === 1 && (await eventsOf(cov.id, "CoverageStatusChanged")).length === 1);
  const arrived = await markArrived({ userId: desk.userId, facilityId: PUNE, staffId: desk.staffId }, ci.id);
  const q = await prisma.queueEntry.findFirst({ where: { appointmentId: a1.id } });
  report("Arrival: the existing check-in (PatientCheckedIn) and straight to the doctor's queue", arrived.status === "ARRIVED" && arrived.queueType === "OPD_DOCTOR" && q?.queueType === "OPD_DOCTOR" && q.practitionerStaffId === doc.staffId && (await eventsOf(a1.id, "PatientCheckedIn")).length === 1);
  report("…PreArrivalCheckInStatusChanged for READY and ARRIVED", (await eventsOf(ci.id, "PreArrivalCheckInStatusChanged")).map((e) => (e.payload as { to: string }).to).join() === "READY,ARRIVED");

  // 4. NEEDS_DESK.
  const a2 = await appointmentIn(rec, 6);
  const ci2 = await submitPreArrival(me, { appointmentId: a2.id, detailsMismatch: true, selfPay: true });
  report("A mismatch goes to the desk (NEEDS_DESK, in plain words); self-pay", ci2.status === "NEEDS_DESK" && ci2.eligibility === "SELF_PAY" && !!ci2.needsDesk);
  const arr2 = await markArrived({ userId: desk.userId, facilityId: PUNE, staffId: desk.staffId }, ci2.id);
  report("…on arrival, the registration queue first", arr2.queueType === "REGISTRATION" && (await prisma.queueEntry.findFirst({ where: { appointmentId: a2.id } }))?.queueType === "REGISTRATION");
  const a3 = await appointmentIn(rec, 7);
  const ci3 = await submitPreArrival(me, { appointmentId: a3.id, detailsConfirmed: true, cardId: card.id });
  const nv = await verifyCheckInCard({ userId: desk.userId, facilityId: PUNE }, ci3.id, { outcome: "NOT_VERIFIED" });
  report("A card that can't be checked: NEEDS_DESK (CARD_NOT_VERIFIED), no coverage", nv.status === "NEEDS_DESK" && nv.eligibility === "NOT_VERIFIED" && !nv.coverageId);

  // 5. Lapsing and cancelling.
  await cancelAppointment(a3.id, "gate", doc.staffId, desk.userId);
  await drain();
  const l3 = await prisma.preArrivalCheckIn.findUniqueOrThrow({ where: { id: ci3.id } });
  report("A cancelled visit lapses its check-in, ending the card share", l3.status === "LAPSED" && (await prisma.cardShare.findUniqueOrThrow({ where: { id: l3.cardShareId! } })).status === "ENDED");
  const a4 = await appointmentIn(rec, 8);
  const ci4 = await submitPreArrival(me, { appointmentId: a4.id, detailsConfirmed: true, selfPay: true, share: {} });
  await markNoShow(a4.id, doc.staffId, desk.userId);
  await drain();
  const l4 = await prisma.preArrivalCheckIn.findUniqueOrThrow({ where: { id: ci4.id } });
  report("A missed visit (no-show) lapses it, ending the check-in share (CHECKIN_ENDED)", l4.status === "LAPSED" && (await prisma.recordShare.findUniqueOrThrow({ where: { id: l4.shareId! } })).endedReason === "CHECKIN_ENDED");
  const a5 = await appointmentIn(rec, 9);
  const ci5 = await submitPreArrival(me, { appointmentId: a5.id, detailsConfirmed: true, selfPay: true });
  report("Someone else can't cancel it (404)", await notFound(cancelPreArrival({ userId: other.userId }, ci5.id)));
  await cancelPreArrival(me, ci5.id);
  report("The patient cancels their own (CANCELLED)", (await prisma.preArrivalCheckIn.findUniqueOrThrow({ where: { id: ci5.id } })).status === "CANCELLED");
  const a6 = await appointmentIn(rec, 10);
  const ci6 = await submitPreArrival(me, { appointmentId: a6.id, detailsConfirmed: true, selfPay: true });
  await sweepStaleCheckIns(new Date(Date.now() + 3 * 86_400_000));
  report("Nobody arrived: the sweep lapses it after its day", (await prisma.preArrivalCheckIn.findUniqueOrThrow({ where: { id: ci6.id } })).status === "LAPSED");

  // 6. Proxies.
  const M = await manager();
  const kid = await child(M, 7);
  const kidRec = await prisma.patient.create({ data: { uhid: `PRE-${tag}`, facilityId: PUNE, fullName: `Kid ${tag}`, sex: "F" } });
  await prisma.personPatientLink.create({ data: { personId: kid.childPersonId, patientId: kidRec.id, facilityId: PUNE, status: "ACTIVE", method: "SELF_CREATED", linkedAt: new Date(), linkedByUserId: "gate" } });
  const aunt = await sharer();
  await prisma.proxyGrant.create({ data: { memberPersonId: kid.childPersonId, proxyPersonId: aunt.personId, householdId: M.householdId, basis: "MEMBER_CHOICE", permissions: ["VIEW", "BOOK"], categories: ["LABS"], status: "ACTIVE", grantedByPersonId: M.personId } });
  const kidCard = await addCard({ userId: M.userId, memberPersonId: kid.childPersonId }, { payerType: "GOVERNMENT_SCHEME", scheme: "PM_JAY", memberId: `PMJ${tag.toUpperCase()}KD01` });
  const k1 = await appointmentIn({ patientId: kidRec.id, facilityId: PUNE, doctorStaffId: doc.staffId }, 4);
  report("A proxy with BOOK but not INSURANCE can't attach the child's card (404)", await notFound(submitPreArrival({ userId: aunt.userId, memberPersonId: kid.childPersonId }, { appointmentId: k1.id, detailsConfirmed: true, cardId: kidCard.id })));
  const kc = await submitPreArrival({ userId: aunt.userId, memberPersonId: kid.childPersonId }, { appointmentId: k1.id, detailsConfirmed: true, selfPay: true });
  report("…but checks the child in, self-pay (logged as a proxy action)", kc.status === "SUBMITTED" && (await prisma.personAccessLogEntry.count({ where: { personId: kid.childPersonId, kind: "PROXY_ACTION", detail: { path: ["action"], equals: "PRE_ARRIVAL_CHECKIN" } } })) === 1);
  const k2 = await appointmentIn({ patientId: kidRec.id, facilityId: PUNE, doctorStaffId: doc.staffId }, 4.5);
  const gc = await submitPreArrival({ userId: M.userId, memberPersonId: kid.childPersonId }, { appointmentId: k2.id, detailsConfirmed: true, cardId: kidCard.id });
  report("The guardian (BOOK + INSURANCE) checks the child in with the PM-JAY card (eligibility pending, verified at the desk)", gc.eligibility === "PENDING" && gc.hasCard);
  report("Someone with no grant can't check the child in (404)", await notFound(submitPreArrival({ userId: other.userId, memberPersonId: kid.childPersonId }, { appointmentId: k2.id, detailsConfirmed: true, selfPay: true })));

  // 7. A planned admission.
  const enc = await prisma.encounter.create({ data: { patientId: P.pune, facilityId: PUNE, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "planned surgery" } });
  const ar = await createAdmissionRequest({ patientId: P.pune, encounterId: enc.id, facilityId: PUNE, requestedByStaffId: doc.staffId, reason: "planned knee replacement", plannedAdmissionAt: new Date(Date.now() + 6 * 3_600_000), byUserId: doc.userId });
  const adm = await submitPreArrival(me, { admissionRequestId: ar.id, detailsConfirmed: true, cardId: card.id, share: { categories: ["LABS", "CONDITIONS"] } });
  const admRow = await prisma.preArrivalCheckIn.findUniqueOrThrow({ where: { id: adm.id } });
  report("A planned admission checks in the same way (kind ADMISSION), its share for the admitting doctor",
    admRow.kind === "ADMISSION" && admRow.admissionRequestId === ar.id && (await prisma.recordShare.findUniqueOrThrow({ where: { id: admRow.shareId! } })).recipientUserId === doc.userId);

  // 8. "Check-in is open".
  const a7 = await appointmentIn(rec, 20);
  const r1 = await sweepCheckInOpen();
  await sweepCheckInOpen();
  report("When check-in opens the patient is told once (CHECKIN_OPEN)", r1.queued >= 1 && (await prisma.personNotification.count({ where: { personId: P.personId, kind: "CHECKIN_OPEN", dedupeKey: { startsWith: `CHECKIN_OPEN:${a7.id}:` } } })) === 1);

  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
