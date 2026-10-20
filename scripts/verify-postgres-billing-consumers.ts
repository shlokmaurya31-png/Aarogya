/**
 * Workflow spine §9 step 9: the claim-drafting and discharge-readiness
 * consumers.
 *
 * claim-drafting
 *   1. Covered patient with an approved pre-authorization: issuing the invoice
 *      drafts one DRAFT claim with it, never submitted; no blocker task.
 *   2. Covered, no pre-authorization: a draft plus one CLAIM_PREAUTH_MISSING
 *      task, closed when a person submits the claim.
 *   3. No coverage: nothing written; the delivery is processed.
 *   4. A claim staff drafted first is left alone (no second claim).
 *   5. A supplementary invoice gets its own draft.
 *   6. Redelivering every event drafts nothing more.
 *
 * discharge-readiness (raise-only)
 *   7. At initiation with no coverage: insuranceReady; nothing else.
 *   8. A final discharge summary → documentationReady (a draft does not).
 *   9. Billing: an unpaid issued invoice is not ready; paying it is.
 *  10. Covered: not insurance-ready while a pre-authorization awaits a
 *      decision; ready once approved.
 *  11. Never lowers a flag a person set; each raise is audited; finalize works.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-billing-consumers.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerPatient } from "../src/lib/patient/registration";
import { openEncounter } from "../src/lib/hospital/encounter";
import { admitPatient, initiateDischarge, updateDischargeReadiness, finalizeDischarge } from "../src/lib/hospital/admission";
import { createCharge } from "../src/lib/hospital/billing/chargeCapture";
import { draftInvoiceForAccount, addChargeToInvoice, issueInvoice, draftSupplementaryInvoice } from "../src/lib/hospital/billing/invoices";
import { recordPayment, allocatePayment } from "../src/lib/hospital/billing/payments";
import { createPayer, addPatientCoverage } from "../src/lib/hospital/billing/coverage";
import { requestPreAuth, decidePreAuth } from "../src/lib/hospital/billing/preauth";
import { createClaimDraft, submitClaim } from "../src/lib/hospital/billing/claims";
import { generateAndStoreDocument } from "../src/lib/documents/service";
import { runTick } from "../src/lib/runner/tick";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const drain = async () => { for (let i = 0; i < 6; i++) if (!(await runTick({ budgetMs: 20_000 })).moreWork) break; };

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const doctor = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(facilityId), { user: { role: "DOCTOR" } }] }, orderBy: { id: "asc" } });
  const by = doctor.userId;
  const payer = await prisma.$transaction((tx) => createPayer(tx, { name: `Consumer Insurer ${run}`, type: "INSURANCE" }));
  const ward = await prisma.ward.create({ data: { facilityId, name: `BC ward ${run}`, wardType: "GENERAL" } });
  let beds = 0;

  /** A patient (optionally covered), an IPD encounter with one charge. */
  const setup = async (label: string, covered: boolean) => {
    const patient = await registerPatient({ facilityId, byUserId: by, fullName: `Billing Consumer ${label} ${run}`, sex: "M", ageYears: 47 });
    const coverage = covered
      ? await prisma.$transaction((tx) => addPatientCoverage(tx, { patientId: patient.id, payerId: payer.id, memberId: `BC-${label}-${run}`, validFrom: new Date(Date.now() - 86_400_000), addedByUserId: by }))
      : null;
    const enc = await openEncounter({ facilityId, patientId: patient.id, type: "IPD", chiefComplaint: label, byUserId: by });
    const charge = await prisma.$transaction((tx) => createCharge(tx, { encounterId: enc.id, patientId: patient.id, facilityId, description: `Care ${label}`, category: "NURSING", unitPriceMinor: 30_000, postedByUserId: by }));
    await drain();
    return { patient, coverage, enc, charge: charge.charge };
  };
  const invoiceAll = (encounterId: string, patientId: string) => prisma.$transaction(async (tx) => {
    const inv = await draftInvoiceForAccount(tx, { encounterId, patientId, facilityId, generatedByUserId: by });
    for (const c of await tx.charge.findMany({ where: { encounterId, status: "POSTED", invoiceLine: null }, select: { id: true } })) await addChargeToInvoice(tx, inv.id, c.id);
    return issueInvoice(tx, inv.id, { byUserId: by });
  });
  const claimOf = (invoiceId: string) => prisma.claim.findUnique({ where: { invoiceId } });
  const blocker = (claimId: string) => prisma.task.findUnique({ where: { facilityId_idempotencyKey: { facilityId, idempotencyKey: `CLAIM_PREAUTH_MISSING:${claimId}` } } });

  // 1. Covered, with an approved pre-authorization.
  const a = await setup("A", true);
  const pre = await prisma.$transaction((tx) => requestPreAuth(tx, { coverageId: a.coverage!.id, encounterId: a.enc.id, requestedAmountMinor: 50_000, requestedByUserId: by }));
  await prisma.$transaction((tx) => decidePreAuth(tx, pre.id, { status: "APPROVED", approvedAmountMinor: 40_000, byUserId: by }));
  const invA = await invoiceAll(a.enc.id, a.patient.id);
  await drain();
  const claimA = await claimOf(invA.id);
  const draftedA = claimA ? await prisma.domainEventOutbox.findFirst({ where: { eventType: "ClaimDrafted", aggregateId: claimA.id } }) : null;
  report("Issuing a covered patient's invoice drafts one claim on the primary coverage, with the approved pre-authorization",
    claimA?.status === "DRAFT" && claimA.coverageId === a.coverage!.id && claimA.preAuthorizationId === pre.id && draftedA?.actorUserId === by);
  report("…never submitted, and no blocker task", claimA?.submittedAt === null && claimA?.claimNumber === null && (await blocker(claimA!.id)) === null);

  // 2. Covered, no pre-authorization.
  const b = await setup("B", true);
  const invB = await invoiceAll(b.enc.id, b.patient.id);
  await drain();
  const claimB = await claimOf(invB.id);
  report("No pre-authorization: a draft plus one CLAIM_PREAUTH_MISSING task for billing",
    claimB?.status === "DRAFT" && claimB.preAuthorizationId === null && (await blocker(claimB.id))?.status === "OPEN" && (await blocker(claimB.id))?.assignedRole === "BILLING_STAFF");
  await prisma.$transaction((tx) => submitClaim(tx, claimB!.id, { byUserId: by }));
  await drain();
  report("…closed when a person submits the claim", (await blocker(claimB!.id))?.status === "COMPLETED");

  // 3. No coverage.
  const c = await setup("C", false);
  const invC = await invoiceAll(c.enc.id, c.patient.id);
  await drain();
  const issuedC = await prisma.domainEventOutbox.findFirstOrThrow({ where: { eventType: "HospitalInvoiceIssued", aggregateId: invC.id } });
  const deliveryC = await prisma.domainEventDelivery.findFirst({ where: { eventId: issuedC.eventId, consumerName: "claim-drafting" } });
  report("No coverage: no claim, and the delivery is processed", (await claimOf(invC.id)) === null && deliveryC?.status === "PROCESSED", deliveryC?.status);

  // 4. Staff drafted first.
  const d = await setup("D", true);
  const staffClaim = await prisma.$transaction(async (tx) => {
    const inv = await draftInvoiceForAccount(tx, { encounterId: d.enc.id, patientId: d.patient.id, facilityId, generatedByUserId: by });
    await addChargeToInvoice(tx, inv.id, d.charge.id);
    const issued = await issueInvoice(tx, inv.id, { byUserId: by });
    return createClaimDraft(tx, { invoiceId: issued.id, coverageId: d.coverage!.id, facilityId, createdByUserId: by });
  });
  await drain();
  report("A claim staff drafted first is left alone", (await prisma.claim.count({ where: { invoiceId: staffClaim.invoiceId } })) === 1
    && (await prisma.domainEventDelivery.findFirst({ where: { consumerName: "claim-drafting", event: { eventType: "HospitalInvoiceIssued", aggregateId: staffClaim.invoiceId } } }))?.status === "PROCESSED");

  // 5. Supplementary invoice.
  await prisma.$transaction((tx) => createCharge(tx, { encounterId: b.enc.id, patientId: b.patient.id, facilityId, description: "Late B", category: "OTHER", unitPriceMinor: 7_000, postedByUserId: by }));
  const supB = await prisma.$transaction(async (tx) => issueInvoice(tx, (await draftSupplementaryInvoice(tx, { originalInvoiceId: invB.id, generatedByUserId: by })).id, { byUserId: by }));
  await drain();
  const supClaim = await claimOf(supB.id);
  report("A supplementary invoice gets its own draft claim", supClaim?.status === "DRAFT" && supClaim.submittedAmountMinor === 7_000);

  // 6. Redelivery.
  const encs = [a.enc.id, b.enc.id, c.enc.id, d.enc.id];
  const ids = (await prisma.domainEventOutbox.findMany({ where: { correlationId: { in: encs } }, select: { eventId: true } })).map((e) => e.eventId);
  const claimsBefore = await prisma.claim.count({ where: { invoice: { encounterId: { in: encs } } } });
  await prisma.domainEventDelivery.updateMany({ where: { eventId: { in: ids } }, data: { status: "PENDING" } });
  await prisma.domainEventOutbox.updateMany({ where: { eventId: { in: ids } }, data: { status: "PENDING", processedAt: null } });
  await drain();
  report("Redelivering every event drafts nothing more", (await prisma.claim.count({ where: { invoice: { encounterId: { in: encs } } } })) === claimsBefore, `${claimsBefore} claims`);

  // 7–11. Discharge readiness.
  const admitted = async (label: string, covered: boolean) => {
    const s = await setup(label, covered);
    const bed = await prisma.bed.create({ data: { facilityId, wardId: ward.id, label: `BC-${run}-${++beds}` } });
    const admission = await admitPatient({ encounterId: s.enc.id, bedId: bed.id, admittingStaffId: doctor.id, reason: label, admissionType: "ELECTIVE", byUserId: by });
    return { ...s, admission };
  };
  const flags = async (id: string) => prisma.discharge.findUniqueOrThrow({ where: { id }, select: { documentationReady: true, billingReady: true, insuranceReady: true, clinicallyReady: true } });

  const e = await admitted("E", false);
  const dischargeE = await initiateDischarge(e.admission.id, by, doctor.id);
  await drain();
  let f = await flags(dischargeE.id);
  report("At initiation, no coverage: insuranceReady only", f.insuranceReady && !f.billingReady && !f.documentationReady, JSON.stringify(f));

  const letterhead = { facilityName: "Aarogya Medical Centre", authorName: "Dr Verify", authorRegistration: "MMC-0000" };
  const summary = { type: "discharge-summary" as const, patient: { name: e.patient.fullName }, diagnoses: ["Observation"] };
  await generateAndStoreDocument(summary, { facilityId, letterhead, issuedByUserId: by, patientId: e.patient.id, encounterId: e.enc.id, isDraft: true });
  await drain();
  report("A draft discharge summary does not make documentation ready", !(await flags(dischargeE.id)).documentationReady);
  await generateAndStoreDocument(summary, { facilityId, letterhead, issuedByUserId: by, patientId: e.patient.id, encounterId: e.enc.id });
  await drain();
  report("A final discharge summary does", (await flags(dischargeE.id)).documentationReady);

  const invE = await invoiceAll(e.enc.id, e.patient.id);
  await drain();
  report("An unpaid issued invoice: not billing-ready", !(await flags(dischargeE.id)).billingReady);
  const pay = await prisma.$transaction((tx) => recordPayment(tx, { encounterId: e.enc.id, patientId: e.patient.id, facilityId, amountMinor: invE.totalMinor, method: "CASH", idempotencyKey: `bc-${run}-e`, receivedByUserId: by }));
  await prisma.$transaction((tx) => allocatePayment(tx, { paymentId: pay.payment.id, invoiceId: invE.id, amountMinor: invE.totalMinor, allocatedByUserId: by }));
  await drain();
  report("Paying it in full: billing-ready", (await flags(dischargeE.id)).billingReady);

  const g = await admitted("G", true);
  const preG = await prisma.$transaction((tx) => requestPreAuth(tx, { coverageId: g.coverage!.id, encounterId: g.enc.id, requestedAmountMinor: 80_000, requestedByUserId: by }));
  const dischargeG = await initiateDischarge(g.admission.id, by, doctor.id);
  await drain();
  report("Covered, a pre-authorization awaiting decision: not insurance-ready", !(await flags(dischargeG.id)).insuranceReady);
  await prisma.$transaction((tx) => decidePreAuth(tx, preG.id, { status: "APPROVED", approvedAmountMinor: 80_000, byUserId: by }));
  await drain();
  report("…approved: insurance-ready", (await flags(dischargeG.id)).insuranceReady);
  const invG = await invoiceAll(g.enc.id, g.patient.id);
  await drain();
  report("An issued invoice carried by the drafted claim: billing-ready without payment", !!(await claimOf(invG.id)) && (await flags(dischargeG.id)).billingReady);

  // 11. Raise-only, audited, finalize.
  await updateDischargeReadiness(dischargeG.id, { documentationReady: true, clinicallyReady: true });
  await prisma.$transaction((tx) => createCharge(tx, { encounterId: g.enc.id, patientId: g.patient.id, facilityId, description: "After the bill", category: "OTHER", unitPriceMinor: 1_000, postedByUserId: by }));
  await drain();
  f = await flags(dischargeG.id);
  report("A flag a person set is never lowered (documentation set by hand, no summary; billing after a new charge)",
    f.documentationReady && f.clinicallyReady && f.billingReady, JSON.stringify(f));
  const audits = await prisma.auditEvent.count({ where: { type: "hospital.discharge.readinessDerived", encounterId: { in: [e.enc.id, g.enc.id] } } });
  report("Each raise is audited", audits >= 4, `${audits} audit rows`);
  await updateDischargeReadiness(dischargeE.id, { clinicallyReady: true, pharmacyReady: true, transportReady: true });
  await finalizeDischarge(dischargeE.id, by, { summary: "gate" });
  report("With the human flags set, the discharge finalizes", (await prisma.discharge.findUniqueOrThrow({ where: { id: dischargeE.id } })).dischargedAt !== null);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
