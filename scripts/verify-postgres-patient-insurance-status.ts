/**
 * Week 5c — what the patient sees of insurance and bills
 * (docs/PATIENT_INSURANCE_DESIGN.md §5, §14), canonical values only:
 *   - a self-pay bill: the itemised lines and the whole total as their share;
 *   - an insured admission, stage by stage: the pre-authorization requested
 *     then approved (with its amount), cashless at discharge, the bill (the
 *     share from the cashless approval, "final once the claim is decided"),
 *     the claim from submitted through the decision (the share recomputed)
 *     to settled; before a decision the share is "not yet known";
 *   - notifications at each change, to the patient and their INSURANCE proxy,
 *     once per event, with no amount, diagnosis or name in the text;
 *   - claim documents: the hospital asks, the patient (never the insurer's
 *     query) attaches uploads: a CLAIM share of exactly those documents for
 *     the facility's billing staff (not ID proofs; sensitive only when
 *     confirmed), never a record view, never the AI, never a doctor or another
 *     facility, ending when the claim settles;
 *   - another patient's coverage, bills and claims are unreachable (canaries);
 *     a proxy without INSURANCE sees nothing.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-patient-insurance-status.ts
 */
import "./lib/gateBootstrap";
import { randomBytes } from "node:crypto";
process.env.SMS_PROVIDER = "outbox";
process.env.EMAIL_PROVIDER = "outbox";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { insuranceStatus } from "../src/lib/insurance/status";
import { attachClaimDocuments, requestClaimDocuments } from "../src/lib/insurance/claimDocuments";
import { addPatientCoverage } from "../src/lib/hospital/billing/coverage";
import { decidePreAuth, requestPreAuth } from "../src/lib/hospital/billing/preauth";
import { recordClaimDecision, settleClaim, submitClaim } from "../src/lib/hospital/billing/claims";
import { initiateDischarge } from "../src/lib/hospital/admission";
import { personDocumentDownload } from "../src/lib/person/documents";
import { viewSharedRecord } from "../src/lib/sharing/view";
import { askAi, AskError } from "../src/lib/rag/ask";
import { NOIDA, PUNE, drain, notFound, refused, reporter, sharer, staff, tag, upload } from "./lib/shareFixture";
import { INSURER, admissionFor, cardKeyForRun, issueBill } from "./lib/insuranceFixture";

const { report, done } = reporter();
process.env.AI_TEXT_KEY_VERSION = "1";
process.env.AI_TEXT_KEY_1 = randomBytes(32).toString("base64");
const tx = <T>(f: (t: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>) => prisma.$transaction(f);

async function main() {
  registerAllConsumers();
  cardKeyForRun();
  const doc = await staff(PUNE, "DOCTOR");
  const billing = await staff(PUNE, "BILLING_STAFF" as never);
  const by = billing.userId;
  const status = async (userId: string, memberPersonId?: string) => insuranceStatus({ userId, memberPersonId });

  // 1. A self-pay visit.
  const S = await sharer();
  await issueBill({ encounterId: S.punEnc, patientId: S.pune, facilityId: PUNE, byUserId: by }, [["Consultation", 800], ["Blood test", 450]]);
  const sv = (await status(S.userId)).visits.find((v) => v.encounterId === S.punEnc)!;
  const sb = sv.bills[0];
  report("Self-pay: the itemised bill (each line) and the whole total as the share", sb.lines.length === 2 && sb.lines.some((l) => l.description === "Consultation" && l.amountMinor === 80_000) && sb.share.basis === "SELF_PAY" && sb.share.shareMinor === 125_000 && sb.payable);

  // 2. An insured admission, stage by stage.
  const P = await sharer();
  const aunt = await sharer();
  await prisma.proxyGrant.create({ data: { memberPersonId: P.personId, proxyPersonId: aunt.personId, basis: "MEMBER_CHOICE", permissions: ["VIEW", "INSURANCE"], categories: ["LABS"], status: "ACTIVE", grantedByPersonId: P.personId } });
  const cov = await tx((t) => addPatientCoverage(t, { patientId: P.pune, payerId: INSURER, memberId: `ST-${tag}`, validFrom: new Date(Date.now() - 86_400_000), addedByUserId: by }));
  const A = await admissionFor(P.pune, PUNE, doc.staffId);
  const pa = await tx((t) => requestPreAuth(t, { coverageId: cov.id, encounterId: A.encounterId, requestedAmountMinor: 500_000, requestedByUserId: by }));
  await drain();
  let v = (await status(P.userId)).visits.find((x) => x.encounterId === A.encounterId)!;
  report("Pre-authorization requested: in plain words, no amount, cashless waiting", v.preAuth?.status === "REQUESTED" && v.preAuth.text.startsWith("The hospital has asked") && v.preAuth.approvedAmountMinor === null && v.cashless?.stage === "WAITING");
  await tx((t) => decidePreAuth(t, pa.id, { status: "APPROVED", approvedAmountMinor: 400_000, byUserId: by }));
  await initiateDischarge(A.admissionId, by, doc.staffId);
  await drain();
  v = (await status(P.userId)).visits.find((x) => x.encounterId === A.encounterId)!;
  report("…approved (₹4,000), and at discharge: cashless approved up to that amount", v.preAuth?.status === "APPROVED" && v.preAuth.approvedAmountMinor === 400_000 && v.cashless?.stage === "APPROVED" && v.cashless.approvedUptoMinor === 400_000 && !!v.discharge);
  const inv = await issueBill({ encounterId: A.encounterId, patientId: P.pune, facilityId: PUNE, byUserId: by }, [["Room (3 days)", 3000], ["Surgery", 1800], ["Medicines", 400]]);
  await drain();
  const claim = await prisma.claim.findUniqueOrThrow({ where: { invoiceId: inv.id } });
  v = (await status(P.userId)).visits.find((x) => x.encounterId === A.encounterId)!;
  let bill = v.bills.find((b) => b.invoiceId === inv.id)!;
  report("The bill: itemised; the share from the cashless approval (₹5,200 − ₹4,000), final once the claim is decided",
    bill.lines.length === 3 && bill.share.basis === "CASHLESS_APPROVAL" && bill.share.shareMinor === 120_000 && bill.share.text.includes("final once the claim is decided") && bill.claim?.status === "DRAFT" && bill.claim.steps.every((s) => !s.done));
  await tx((t) => submitClaim(t, claim.id, { byUserId: by }));
  await tx((t) => recordClaimDecision(t, claim.id, { status: "UNDER_REVIEW", byUserId: by }));
  bill = (await status(P.userId)).visits.find((x) => x.encounterId === A.encounterId)!.bills.find((b) => b.invoiceId === inv.id)!;
  report("Claim submitted, then under review (the steps say so)", bill.claim?.status === "UNDER_REVIEW" && bill.claim.steps.filter((s) => s.done).map((s) => s.key).join() === "SUBMITTED,UNDER_REVIEW");
  await tx((t) => recordClaimDecision(t, claim.id, { status: "PARTIALLY_APPROVED", approvedAmountMinor: 380_000, byUserId: by }));
  bill = (await status(P.userId)).visits.find((x) => x.encounterId === A.encounterId)!.bills.find((b) => b.invoiceId === inv.id)!;
  report("Partly approved: the share recomputed from the insurer's decision (₹5,200 − ₹3,800)", bill.share.basis === "CLAIM" && bill.share.shareMinor === 140_000 && bill.claim?.approvedAmountMinor === 380_000 && bill.claim.text.includes("part"));

  // A second insured admission with no decision yet: not yet known.
  const B = await admissionFor(P.pune, PUNE, doc.staffId);
  await tx((t) => requestPreAuth(t, { coverageId: cov.id, encounterId: B.encounterId, requestedAmountMinor: 100_000, requestedByUserId: by }));
  const invB = await issueBill({ encounterId: B.encounterId, patientId: P.pune, facilityId: PUNE, byUserId: by }, [["Day care", 900]]);
  await drain();
  const bB = (await status(P.userId)).visits.find((x) => x.encounterId === B.encounterId)!.bills.find((b) => b.invoiceId === invB.id)!;
  report("No insurer decision yet: the share is \"not yet known\" and nothing is payable", !bB.share.known && bB.share.shareMinor === null && !bB.payable && bB.share.text.startsWith("Not yet known"));

  // 3. Claim documents.
  const d1 = await upload(P.personId, `Discharge summary ${tag}`);
  const d2 = await upload(P.personId, `Old X-ray ${tag}`);
  const dHiv = await upload(P.personId, `HIV test report ${tag}`);
  const dId = await upload(P.personId, `Aadhaar ${tag}`, { type: "ID_PROOF" });
  const other = await sharer();
  const dOther = await upload(other.personId, `Not theirs ${tag}`);
  const req = await requestClaimDocuments({ userId: by, facilityId: PUNE }, claim.id, "The insurer asks for the discharge summary.");
  await drain();
  bill = (await status(P.userId)).visits.find((x) => x.encounterId === A.encounterId)!.bills.find((b) => b.invoiceId === inv.id)!;
  report("The hospital asks for a document: the patient sees what is needed", bill.documentRequests.some((r) => r.id === req.id && r.status === "OPEN" && r.description.includes("discharge summary")));
  report("Another facility can't ask about this claim (404)", await notFound(requestClaimDocuments({ userId: by, facilityId: NOIDA }, claim.id, "Anything please")));
  report("Someone else's upload can't be attached (404)", await notFound(attachClaimDocuments({ userId: P.userId }, req.id, { documentIds: [dOther] })));
  report("An ID proof isn't shared this way", await refused(attachClaimDocuments({ userId: P.userId }, req.id, { documentIds: [dId] })));
  report("A sensitive document needs the patient's confirmation", await refused(attachClaimDocuments({ userId: P.userId }, req.id, { documentIds: [d1, dHiv] })));
  report("Someone else can't answer the request (404)", await notFound(attachClaimDocuments({ userId: other.userId }, req.id, { documentIds: [dOther] })));
  const att = await attachClaimDocuments({ userId: P.userId }, req.id, { documentIds: [d1] });
  const cshare = await prisma.recordShare.findUniqueOrThrow({ where: { id: att.shareId } });
  report("Attached: a CLAIM share for the facility of exactly that document", cshare.kind === "CLAIM" && cshare.recipientFacilityId === PUNE && cshare.documentIds.join() === d1 && cshare.categories.join() === "UPLOADS");
  const dl = (role: string, facilityId: string, documentId: string, userId = by) => personDocumentDownload({ kind: "SHARE", userId, facilityId, role, shareRef: cshare.id }, documentId);
  report("Billing staff open the attached document", !!(await dl("BILLING_STAFF", PUNE, d1)).url);
  report("…not another of the patient's uploads through it (404)", await notFound(dl("BILLING_STAFF", PUNE, d2)));
  report("…never as a record view (404)", await notFound(viewSharedRecord({ userId: by, facilityId: PUNE, role: "BILLING_STAFF" }, cshare.id, "SHARED_RECORD_VIEW")));
  const ai = await askAi({ kind: "STAFF", userId: doc.userId, role: "DOCTOR", facilityId: PUNE }, { mode: "VISIT_BRIEF", patientId: P.pune, shareId: cshare.id }).then(() => "answered", (e) => (e instanceof AskError ? `refused ${e.status}` : `error ${e}`));
  report("…never the AI (404)", ai === "refused 404");
  report("A doctor, or another facility's billing staff, can't open it (404)", await notFound(dl("DOCTOR", PUNE, d1, doc.userId)) && await notFound(dl("BILLING_STAFF", NOIDA, d1)));
  await tx((t) => settleClaim(t, claim.id, { settledAmountMinor: 380_000, byUserId: by }));
  await drain();
  bill = (await status(P.userId)).visits.find((x) => x.encounterId === A.encounterId)!.bills.find((b) => b.invoiceId === inv.id)!;
  report("Settled: the last step done, the amount and date shown", bill.claim?.status === "SETTLED" && bill.claim.steps.every((s) => s.done) && bill.claim.settledAmountMinor === 380_000 && !!bill.claim.settledAt);
  report("…and the claim's document share ended (CLAIM_CLOSED): staff can't open it now (404)", (await prisma.recordShare.findUniqueOrThrow({ where: { id: cshare.id } })).endedReason === "CLAIM_CLOSED" && await notFound(dl("BILLING_STAFF", PUNE, d1)));

  // 4. Notifications.
  const notes = await prisma.personNotification.findMany({ where: { personId: P.personId } });
  const kinds = (k: string) => notes.filter((n) => n.kind === k).length;
  report("The patient is told at each change (pre-auth, discharge, claim) and of the bill and the documents asked",
    kinds("INSURANCE_UPDATE") >= 5 && kinds("BILL_READY") >= 2 && kinds("DOCUMENTS_REQUESTED") === 1);
  const auntNotes = await prisma.personNotification.count({ where: { personId: aunt.personId, kind: { in: ["INSURANCE_UPDATE", "BILL_READY", "DOCUMENTS_REQUESTED"] } } });
  report("…and so is their INSURANCE proxy", auntNotes === notes.filter((n) => ["INSURANCE_UPDATE", "BILL_READY", "DOCUMENTS_REQUESTED"].includes(n.kind)).length);
  report("No notification carries an amount, a diagnosis or a name", notes.every((n) => !/\d{3}|₹|Rs\.?\s?\d/.test(`${n.title} ${n.body}`) && !`${n.title} ${n.body}`.includes("Surgery") && !`${n.title} ${n.body}`.includes("Share ")));
  const ids = notes.map((n) => n.dedupeKey);
  report("…once per event and person", new Set(ids).size === ids.length);

  // 5. Canaries and proxies.
  const X = await sharer();
  const covX = await tx((t) => addPatientCoverage(t, { patientId: X.pune, payerId: INSURER, memberId: `CANARY-${tag}`, validFrom: new Date(Date.now() - 86_400_000), addedByUserId: by }));
  const AX = await admissionFor(X.pune, PUNE, doc.staffId);
  await tx((t) => requestPreAuth(t, { coverageId: covX.id, encounterId: AX.encounterId, requestedAmountMinor: 777_700, requestedByUserId: by }));
  const invX = await issueBill({ encounterId: AX.encounterId, patientId: X.pune, facilityId: PUNE, byUserId: by }, [[`Canary line ${tag}`, 7777]]);
  await drain();
  const mine = JSON.stringify(await status(P.userId));
  report("Another patient's coverage, bill and claim never appear (canaries)", !mine.includes(`Canary line ${tag}`) && !mine.includes(invX.id) && !mine.includes(AX.encounterId) && !mine.includes("777700"));
  report("The INSURANCE proxy sees the member's status", (await status(aunt.userId, P.personId)).visits.some((x) => x.encounterId === A.encounterId));
  const viewer = await sharer();
  await prisma.proxyGrant.create({ data: { memberPersonId: P.personId, proxyPersonId: viewer.personId, basis: "MEMBER_CHOICE", permissions: ["VIEW"], categories: ["LABS"], status: "ACTIVE", grantedByPersonId: P.personId } });
  report("A proxy without INSURANCE sees nothing (404)", await notFound(status(viewer.userId, P.personId)));

  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
