/**
 * Flagship 5, step 5 — cashless insurance, phase 1, behind the mock NHCX
 * adapter (docs/CASHLESS_CLAIMS_DESIGN.md §12, §15).
 *
 *   1. Eligibility from a card shared at check-in: eligible verifies the card
 *      into coverage (method ELIGIBILITY); not eligible leaves it; another
 *      hospital gets a 404.
 *   2. A request from the admission: refused without coverage, without
 *      documents, with an ID proof or another patient's document; built with
 *      the documents PROPOSED, the patient (and INSURANCE proxies) told, and
 *      nothing sent.
 *   3. No document leaves without the patient's approval: the request waits;
 *      every proposed document must be decided; exactly the approved ones
 *      reach the exchange, a removed one never; a sensitive one needs
 *      confirmation.
 *   4. Household proxies: INSURANCE for that member follows and approves (in
 *      the member's access log, via PROXY); a proxy without INSURANCE, a
 *      stranger and another household see nothing.
 *   5. The insurer's responses: query (the desk answers, with a further
 *      document approved first), partial, approved, rejected, each driving
 *      the desk's queue and the patient's status ("Approved ₹X; your share
 *      ₹Y") and the canonical pre-authorisation; a replayed response is a
 *      no-op; a late one is kept, not applied.
 *   6. Another hospital can't see, answer or cancel the request.
 *   7. Events: each change in its transaction, no diagnosis, title, question
 *      or amount in any of them; notifications carry none either.
 */
import "./lib/gateBootstrap";
process.env.SMS_PROVIDER = "outbox";
process.env.EMAIL_PROVIDER = "outbox";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { addCard } from "../src/lib/insurance/cards";
import { submitPreArrival } from "../src/lib/insurance/checkin";
import { addPatientCoverage } from "../src/lib/hospital/billing/coverage";
import { mockSent } from "../src/lib/insurance/cashless/adapter";
import {
  answerCashlessQuery, cancelCashlessRequest, checkEligibilityAtCheckIn, decideCashlessDocuments, deskCashlessQueue, mockInsurerRespond, patientCashless, startCashlessRequest,
} from "../src/lib/insurance/cashless/service";
import { NOIDA, PUNE, drain, notFound, refused, reporter, sharer, staff, tag } from "./lib/shareFixture";
import { INSURER, admissionFor, appointmentIn, cardKeyForRun } from "./lib/insuranceFixture";

const { report, done } = reporter();
const DIAGNOSIS = `Acute appendicitis ${tag}`;
const PROCEDURE = `Laparoscopic appendectomy ${tag}`;
const QUESTION = `Please send the ultrasound findings ${tag}`;

async function main() {
  registerAllConsumers();
  cardKeyForRun();
  const doc = await staff(PUNE, "DOCTOR");
  const desk = await staff(PUNE, "HOSPITAL_ADMIN");
  const noidaDesk = await staff(NOIDA, "HOSPITAL_ADMIN");
  const D = { userId: desk.userId, facilityId: PUNE };
  const ND = { userId: noidaDesk.userId, facilityId: NOIDA };

  // 1. Eligibility at check-in.
  const P = await sharer();
  const card = await addCard({ userId: P.userId }, { payerType: "PRIVATE_INSURER", payerId: INSURER, memberId: `CL${tag.toUpperCase()}AB12` });
  const ci = await submitPreArrival({ userId: P.userId }, { appointmentId: (await appointmentIn({ patientId: P.pune, facilityId: PUNE, doctorStaffId: doc.staffId }, 5)).id, detailsConfirmed: true, cardId: card.id });
  report("Another hospital can't check a check-in's card: 404", await notFound(checkEligibilityAtCheckIn(ND, ci.id)));
  const el = await checkEligibilityAtCheckIn(D, ci.id);
  const cov = el.coverageId ? await prisma.patientCoverage.findUnique({ where: { id: el.coverageId } }) : null;
  const verified = await prisma.domainEventOutbox.findFirst({ where: { eventType: "CoverageVerifiedFromCard", aggregateId: ci.id }, orderBy: { createdAt: "desc" } });
  report("Eligible through the exchange: the card is verified into the facility's coverage, method ELIGIBILITY",
    el.result === "ELIGIBLE" && cov?.sourceCardId === card.id && cov.status === "ACTIVE" && (verified?.payload as { method?: string })?.method === "ELIGIBILITY"
      && (await prisma.domainEventOutbox.count({ where: { eventType: "CashlessEligibilityChecked", aggregateId: el.eligibilityId } })) === 1);
  const Q = await sharer();
  const qCard = await addCard({ userId: Q.userId }, { payerType: "PRIVATE_INSURER", payerId: INSURER, memberId: `CL${tag.toUpperCase()}0000` });
  const qCi = await submitPreArrival({ userId: Q.userId }, { appointmentId: (await appointmentIn({ patientId: Q.pune, facilityId: PUNE, doctorStaffId: doc.staffId }, 5)).id, detailsConfirmed: true, cardId: qCard.id });
  const qEl = await checkEligibilityAtCheckIn(D, qCi.id);
  report("Not eligible: recorded, and no coverage is created (the desk's manual check stays)", qEl.result === "NOT_ELIGIBLE" && qEl.coverageId === null && (await prisma.patientCoverage.count({ where: { patientId: Q.pune } })) === 0);
  report("The exchange was sent the last 4 of the member id only", mockSent.filter((m) => m.kind === "ELIGIBILITY").every((m) => JSON.stringify(m).includes("AB12") || JSON.stringify(m).includes("0000")) && !JSON.stringify(mockSent).includes(`CL${tag.toUpperCase()}AB12`));

  // 2. The request from the admission.
  const A = await admissionFor(P.pune, PUNE, doc.staffId);
  const cdoc = (title: string, patientId = P.pune, type = "REPORT") => prisma.clinicalDocument.create({ data: { facilityId: PUNE, patientId, encounterId: patientId === P.pune ? A.encounterId : null, type, title: `${title} ${tag}`, uploadedByStaffId: doc.staffId, storageRef: `gate/${tag}/${title}` } });
  const note = await cdoc("Admission note");
  const usg = await cdoc("Ultrasound abdomen");
  const estimate = await cdoc("Cost estimate");
  const idProof = await cdoc("Aadhaar card", P.pune, "ID_PROOF");
  const hiv = await cdoc("HIV test report");
  const othersDoc = await cdoc("Someone else's report", Q.pune);
  const base = { encounterId: A.encounterId, diagnosis: DIAGNOSIS, plannedProcedure: PROCEDURE, estimateMinor: 500_000 };
  report("Refused without documents, with an ID proof, or with another patient's document",
    (await refused(startCashlessRequest(D, { ...base, documentIds: [] }))) && (await refused(startCashlessRequest(D, { ...base, documentIds: [note.id, idProof.id] }))) && (await notFound(startCashlessRequest(D, { ...base, documentIds: [othersDoc.id] }))));
  const qA = await admissionFor(Q.pune, PUNE, doc.staffId);
  report("Refused without active coverage (the card wasn't eligible)", await refused(startCashlessRequest(D, { ...base, encounterId: qA.encounterId, documentIds: [othersDoc.id] })));
  report("Another hospital can't start one on this admission: 404", await notFound(startCashlessRequest(ND, { ...base, documentIds: [note.id] })));
  const aunt = await sharer();
  const uncle = await sharer();
  await prisma.proxyGrant.create({ data: { memberPersonId: P.personId, proxyPersonId: aunt.personId, basis: "MEMBER_CHOICE", permissions: ["VIEW", "INSURANCE"], categories: ["LABS"], status: "ACTIVE", grantedByPersonId: P.personId } });
  await prisma.proxyGrant.create({ data: { memberPersonId: P.personId, proxyPersonId: uncle.personId, basis: "MEMBER_CHOICE", permissions: ["VIEW"], categories: ["LABS"], status: "ACTIVE", grantedByPersonId: P.personId } });
  const sentBefore = mockSent.length;
  const r1 = await startCashlessRequest(D, { ...base, documentIds: [note.id, usg.id] });
  const row1 = await prisma.cashlessRequest.findUniqueOrThrow({ where: { id: r1.id }, include: { documents: true } });
  report("Built from the admission: waiting for the patient, both documents proposed, nothing sent, no pre-authorisation yet",
    r1.status === "AWAITING_PATIENT" && row1.documents.length === 2 && row1.documents.every((d) => d.status === "PROPOSED") && mockSent.length === sentBefore && row1.preAuthorizationId === null);
  report("…the patient and their INSURANCE proxy are told (a notification each), the VIEW-only proxy isn't",
    (await prisma.personNotification.count({ where: { personId: P.personId, kind: "DOCUMENTS_REQUESTED", dedupeKey: { startsWith: `CASHLESS:${r1.id}:1` } } })) === 1
      && (await prisma.personNotification.count({ where: { personId: aunt.personId, dedupeKey: { startsWith: `CASHLESS:${r1.id}` } } })) === 1
      && (await prisma.personNotification.count({ where: { personId: uncle.personId, dedupeKey: { startsWith: `CASHLESS:${r1.id}` } } })) === 0);
  report("One open request per admission", await refused(startCashlessRequest(D, { ...base, documentIds: [estimate.id] })));

  // 4. Who sees it.
  const own = (await patientCashless({ userId: P.userId })).requests.find((x) => x.id === r1.id);
  const viaAunt = (await patientCashless({ userId: aunt.userId, memberPersonId: P.personId })).requests.find((x) => x.id === r1.id);
  report("The patient sees the documents to approve, in plain words", !!own && own.status === "AWAITING_PATIENT" && own.documents.filter((d) => d.toDecide).length === 2 && own.approvedAmountMinor === null && own.shareMinor === null);
  report("…their INSURANCE proxy too (in the member's access log)", !!viaAunt && (await prisma.personAccessLogEntry.count({ where: { personId: P.personId, actorUserId: aunt.userId, detail: { path: ["action"], equals: "CASHLESS_VIEWED" } } })) >= 1);
  report("A proxy without INSURANCE, a stranger as proxy, and another person: nothing",
    (await notFound(patientCashless({ userId: uncle.userId, memberPersonId: P.personId }))) && (await notFound(patientCashless({ userId: Q.userId, memberPersonId: P.personId })))
      && !(await patientCashless({ userId: Q.userId })).requests.some((x) => x.id === r1.id)
      && (await notFound(decideCashlessDocuments({ userId: Q.userId }, r1.id, { decisions: [] }))) && (await notFound(decideCashlessDocuments({ userId: uncle.userId, memberPersonId: P.personId }, r1.id, { decisions: [] }))));

  // 3. Approval: every proposed document decided; exactly the approved ones leave.
  const [dNote, dUsg] = [row1.documents.find((d) => d.clinicalDocumentId === note.id)!, row1.documents.find((d) => d.clinicalDocumentId === usg.id)!];
  report("Deciding only some of the proposed documents is refused; nothing is sent", (await refused(decideCashlessDocuments({ userId: P.userId }, r1.id, { decisions: [{ documentId: dNote.id, decision: "APPROVE" }] }))) && mockSent.length === sentBefore);
  const dec = await decideCashlessDocuments({ userId: aunt.userId, memberPersonId: P.personId }, r1.id, { decisions: [{ documentId: dNote.id, decision: "APPROVE" }, { documentId: dUsg.id, decision: "REMOVE" }] });
  const sent1 = mockSent.filter((m) => m.kind === "PREAUTH" && m.requestId === r1.id);
  const pa = await prisma.preAuthorization.findUnique({ where: { id: dec.preAuthorizationId ?? "" } });
  report("The proxy approves one and removes one: sent with exactly the approved document, never the removed one",
    dec.status === "SUBMITTED" && sent1.length === 1 && sent1[0].kind === "PREAUTH" && sent1[0].documents.map((d) => d.id).join() === note.id && !JSON.stringify(mockSent).includes(usg.id));
  report("…the canonical pre-authorisation is requested for the estimate (its own event)", pa?.status === "REQUESTED" && pa.requestedAmountMinor === 500_000 && pa.coverageId === cov!.id
    && (await prisma.domainEventOutbox.count({ where: { eventType: "PreauthStatusChanged", aggregateId: pa.id } })) === 1);
  report("…each decision recorded as the proxy's, with its event, and in the member's access log",
    (await prisma.cashlessDocument.count({ where: { requestId: r1.id, decidedVia: "PROXY", decidedByUserId: aunt.userId } })) === 2
      && (await prisma.domainEventOutbox.count({ where: { eventType: "CashlessDocumentDecided", aggregateId: r1.id } })) === 2
      && (await prisma.personAccessLogEntry.count({ where: { personId: P.personId, actorUserId: aunt.userId, detail: { path: ["action"], equals: "CASHLESS_DOCUMENTS" } } })) === 1);
  report("Nothing waits for approval now: deciding again is refused", await refused(decideCashlessDocuments({ userId: P.userId }, r1.id, { decisions: [] })));

  // 6. Another hospital.
  report("Another hospital's desk: not in its queue; answer and cancel are 404",
    !JSON.stringify(await deskCashlessQueue(ND)).includes(r1.id) && (await notFound(answerCashlessQuery(ND, r1.id, { answer: "Anything at all" }))) && (await notFound(cancelCashlessRequest(ND, r1.id)))
      && (await notFound(mockInsurerRespond(NOIDA, r1.id, { decision: "APPROVED", approvedAmountMinor: 1 }))));
  report("The desk's queue has it open, with the patient", (await deskCashlessQueue(D)).open.some((x) => x.id === r1.id && x.patient?.uhid && x.documents.length === 2));

  // 5. A query, answered with a further document the patient approves first.
  const q1 = await mockInsurerRespond(PUNE, r1.id, { decision: "QUERY", queryText: QUESTION });
  const afterQuery = await prisma.cashlessRequest.findUniqueOrThrow({ where: { id: r1.id } });
  const pq = (await patientCashless({ userId: P.userId })).requests.find((x) => x.id === r1.id)!;
  report("A query: the desk sees the question; the patient sees only that one was asked (and is told)",
    q1.applied && afterQuery.status === "QUERY" && afterQuery.queryText === QUESTION && (await deskCashlessQueue(D)).open.find((x) => x.id === r1.id)?.queryText === QUESTION
      && pq.status === "QUERY" && pq.text.includes("asked the hospital a question") && !JSON.stringify(pq).includes(QUESTION)
      && (await prisma.personNotification.count({ where: { personId: P.personId, dedupeKey: { startsWith: `CASHLESS_QUERY:${r1.id}:1` } } })) === 1);
  const eventsBefore = await prisma.domainEventOutbox.count({ where: { aggregateId: r1.id } });
  const replay = await mockInsurerRespond(PUNE, r1.id, { decision: "QUERY", queryText: "a second copy", externalMessageId: q1.externalMessageId });
  report("A replayed insurer response is a no-op: no message, no event, no change",
    replay.replayed && !replay.applied && (await prisma.cashlessInsurerMessage.count({ where: { requestId: r1.id } })) === 1
      && (await prisma.domainEventOutbox.count({ where: { aggregateId: r1.id } })) === eventsBefore && (await prisma.cashlessRequest.findUniqueOrThrow({ where: { id: r1.id } })).queryText === QUESTION);
  report("…and the same message replayed as an approval changes nothing either", (await mockInsurerRespond(PUNE, r1.id, { decision: "APPROVED", approvedAmountMinor: 500_000, externalMessageId: q1.externalMessageId })).replayed && (await prisma.cashlessRequest.findUniqueOrThrow({ where: { id: r1.id } })).status === "QUERY");
  report("The answer can't propose a document already on the request", await refused(answerCashlessQuery(D, r1.id, { answer: "Attached again", documentIds: [usg.id] })));
  const ans = await answerCashlessQuery(D, r1.id, { answer: "The cost estimate is attached; the ultrasound shows an inflamed appendix.", documentIds: [estimate.id] });
  const answersBefore = mockSent.filter((m) => m.kind === "QUERY_ANSWER" && m.requestId === r1.id).length;
  report("The desk's answer adds a document: it waits for the patient, nothing is sent yet", ans.status === "AWAITING_PATIENT" && answersBefore === 0);
  const dEst = (await prisma.cashlessDocument.findFirstOrThrow({ where: { requestId: r1.id, clinicalDocumentId: estimate.id } }));
  await decideCashlessDocuments({ userId: P.userId }, r1.id, { decisions: [{ documentId: dEst.id, decision: "APPROVE" }] });
  const answers = mockSent.filter((m) => m.kind === "QUERY_ANSWER" && m.requestId === r1.id);
  report("The patient approves it: the answer goes with exactly that document, and the request is with the insurer again",
    answers.length === 1 && answers[0].kind === "QUERY_ANSWER" && answers[0].documents.map((d) => d.id).join() === estimate.id && (await prisma.cashlessRequest.findUniqueOrThrow({ where: { id: r1.id } })).status === "SUBMITTED"
      && (await prisma.cashlessDocument.findUniqueOrThrow({ where: { id: dEst.id } })).decidedVia === "OWNER");

  // Partial approval.
  const part = await mockInsurerRespond(PUNE, r1.id, { decision: "PARTIAL", approvedAmountMinor: 300_000, reason: "SUB_LIMIT" });
  await drain();
  const pp = (await patientCashless({ userId: P.userId })).requests.find((x) => x.id === r1.id)!;
  const paDecided = await prisma.preAuthorization.findUniqueOrThrow({ where: { id: dec.preAuthorizationId! } });
  report("Partial: the patient sees \"Approved ₹3,000; your share ₹2,000\" from the hospital's estimate, with the reason",
    part.applied && pp.status === "PARTIAL" && pp.approvedAmountMinor === 300_000 && pp.shareMinor === 200_000 && pp.shareText?.includes("estimate") === true && pp.reasonText?.includes("limit") === true);
  report("…the canonical pre-authorisation is approved for ₹3,000 (PreauthDecided), and the desk's queue has it decided",
    paDecided.status === "APPROVED" && paDecided.approvedAmountMinor === 300_000 && (await prisma.domainEventOutbox.count({ where: { eventType: "PreauthDecided", aggregateId: paDecided.id } })) === 1
      && (await deskCashlessQueue(D)).decided.some((x) => x.id === r1.id && x.status === "PARTIAL"));
  const late = await mockInsurerRespond(PUNE, r1.id, { decision: "APPROVED", approvedAmountMinor: 500_000 });
  report("A late response after the decision is kept, not applied", !late.applied && !late.replayed && (await prisma.cashlessRequest.findUniqueOrThrow({ where: { id: r1.id } })).status === "PARTIAL"
    && (await prisma.cashlessInsurerMessage.count({ where: { requestId: r1.id, applied: false } })) === 1);

  // Approved in full, and rejected.
  const R = await sharer();
  const rCov = await prisma.$transaction((t) => addPatientCoverage(t, { patientId: R.pune, payerId: INSURER, memberId: `CLR-${tag}`, validFrom: new Date(Date.now() - 86_400_000), addedByUserId: desk.userId }));
  const rA = await admissionFor(R.pune, PUNE, doc.staffId);
  const rDoc = await prisma.clinicalDocument.create({ data: { facilityId: PUNE, patientId: R.pune, encounterId: rA.encounterId, type: "REPORT", title: `Admission note R ${tag}`, uploadedByStaffId: doc.staffId } });
  const r2 = await startCashlessRequest(D, { encounterId: rA.encounterId, coverageId: rCov.id, diagnosis: DIAGNOSIS, plannedProcedure: PROCEDURE, estimateMinor: 250_000, documentIds: [rDoc.id] });
  const r2d = await prisma.cashlessDocument.findFirstOrThrow({ where: { requestId: r2.id } });
  await decideCashlessDocuments({ userId: R.userId }, r2.id, { decisions: [{ documentId: r2d.id, decision: "APPROVE" }] });
  await mockInsurerRespond(PUNE, r2.id, { decision: "APPROVED", approvedAmountMinor: 250_000 });
  const pr2 = (await patientCashless({ userId: R.userId })).requests.find((x) => x.id === r2.id)!;
  report("Approved in full: \"Approved ₹2,500; your share ₹0\"", pr2.status === "APPROVED" && pr2.approvedAmountMinor === 250_000 && pr2.shareMinor === 0);
  const S = await sharer();
  await prisma.$transaction((t) => addPatientCoverage(t, { patientId: S.pune, payerId: INSURER, memberId: `CLS-${tag}`, validFrom: new Date(Date.now() - 86_400_000), addedByUserId: desk.userId }));
  const sA = await admissionFor(S.pune, PUNE, doc.staffId);
  const sDoc = await prisma.clinicalDocument.create({ data: { facilityId: PUNE, patientId: S.pune, encounterId: sA.encounterId, type: "REPORT", title: `HIV test report S ${tag}`, uploadedByStaffId: doc.staffId } });
  const r3 = await startCashlessRequest(D, { ...base, encounterId: sA.encounterId, documentIds: [sDoc.id] });
  const r3d = await prisma.cashlessDocument.findFirstOrThrow({ where: { requestId: r3.id } });
  report("A document that looks sensitive needs the patient's confirmation; nothing is sent until then",
    (await refused(decideCashlessDocuments({ userId: S.userId }, r3.id, { decisions: [{ documentId: r3d.id, decision: "APPROVE" }] }))) && !mockSent.some((m) => m.kind === "PREAUTH" && m.requestId === r3.id));
  await decideCashlessDocuments({ userId: S.userId }, r3.id, { decisions: [{ documentId: r3d.id, decision: "APPROVE" }], confirmSensitive: true });
  await mockInsurerRespond(PUNE, r3.id, { decision: "REJECTED", reason: "WAITING_PERIOD" });
  const pr3 = (await patientCashless({ userId: S.userId })).requests.find((x) => x.id === r3.id)!;
  const pa3 = await prisma.preAuthorization.findFirstOrThrow({ where: { encounterId: sA.encounterId } });
  report("Rejected: the patient is told plainly, with the reason; the pre-authorisation is denied; no amount", pr3.status === "REJECTED" && pr3.text.includes("did not approve") && pr3.reasonText?.includes("waiting period") === true && pr3.approvedAmountMinor === null && pa3.status === "DENIED");
  report("Cancelling a decided request is refused", await refused(cancelCashlessRequest(D, r3.id)));
  report("An approval without its amount, or a 'partial' at the estimate, is refused",
    (await refused(mockInsurerRespond(PUNE, r3.id, { decision: "APPROVED" }))) && (await refused(mockInsurerRespond(PUNE, r3.id, { decision: "PARTIAL", approvedAmountMinor: 500_000 }))));

  // Exactly the approved documents left, everywhere; a hospital document never proposed never left.
  const approvedIds = new Set((await prisma.cashlessDocument.findMany({ where: { status: "APPROVED" }, select: { clinicalDocumentId: true } })).map((d) => d.clinicalDocumentId));
  const everSent = mockSent.flatMap((m) => (m.kind === "PREAUTH" || m.kind === "QUERY_ANSWER" ? m.documents.map((d) => d.id) : []));
  report("No document left without the patient's approval (every document the exchange was sent was approved)", everSent.length >= 4 && everSent.every((d) => approvedIds.has(d)) && !everSent.includes(hiv.id) && !everSent.includes(idProof.id));

  // 7. Events and notifications carry nothing private.
  const ids = [r1.id, r2.id, r3.id];
  const evs = await prisma.domainEventOutbox.findMany({ where: { aggregateId: { in: ids }, eventType: { startsWith: "Cashless" } }, orderBy: { seq: "asc" }, select: { eventType: true, payload: true } });
  const blob = JSON.stringify(evs);
  const transitions = evs.filter((e) => e.eventType === "CashlessRequestStatusChanged" && (e.payload as { requestId: string }).requestId === r1.id).map((e) => `${(e.payload as { from: string }).from}>${(e.payload as { to: string }).to}`);
  report("Every change of the request has its event, in order", transitions.join(" ") === "NONE>AWAITING_PATIENT AWAITING_PATIENT>SUBMITTED SUBMITTED>QUERY QUERY>AWAITING_PATIENT AWAITING_PATIENT>SUBMITTED SUBMITTED>PARTIAL", transitions.join(" "));
  report("No diagnosis, procedure, document title, question or amount in any event", ![DIAGNOSIS, PROCEDURE, QUESTION, "Admission note", "Ultrasound", "300000", "500000", "mount"].some((s) => blob.includes(s)));
  const notes = await prisma.personNotification.findMany({ where: { personId: { in: [P.personId, aunt.personId, R.personId, S.personId] }, createdAt: { gte: row1.createdAt } }, select: { title: true, body: true } });
  report("Notifications carry no amount, diagnosis or document", notes.length > 0 && !notes.some((n) => /₹|\d{3,}|appendic|ultrasound|estimate/i.test(`${n.title} ${n.body}`)), `${notes.length} notifications`);

  await done();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
