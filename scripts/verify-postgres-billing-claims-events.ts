/**
 * Workflow spine §9 step 9: hospital billing and claims events. Each one is
 * emitted in the transaction of the change it reports, correlated by the
 * encounter, with IDs, amounts and closed codes only (never a reason, a
 * denial text or a note).
 *
 *   1. Charges: ChargePosted from every path (manual, in-transaction lab
 *      order), an unknown category refused, ChargeVoided.
 *   2. Invoices: HospitalInvoiceIssued (lines, total, document type),
 *      HospitalInvoiceVoided (from ISSUED).
 *   3. Payments: HospitalPaymentRecorded once (a replay emits nothing),
 *      HospitalPaymentStatusChanged ALLOCATED (with the invoice's new status)
 *      and VOIDED.
 *   4. Refunds and adjustments: only the outcome emits (completed, rejected;
 *      approved, rejected), by the deciding user.
 *   5. Coverage and pre-authorization: CoverageStatusChanged (added,
 *      deactivated; a second deactivation emits nothing), PreauthStatusChanged
 *      (requested, expired) and PreauthDecided.
 *   6. Claims (direct path): ClaimDrafted, ClaimSubmitted (DIRECT),
 *      ClaimStatusChanged per decision, ClaimSettled (stage SETTLED),
 *      ClaimStatusChanged on close.
 *   7. No payload carries the free text the calls were given.
 *
 * NHCX (dispatch, queries, settlements, exceptions) is asserted in
 * verify-postgres-nhcx; commercial billing in verify-postgres-saas-billing and
 * verify-postgres-commercial-entitlements.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-billing-claims-events.ts
 */
import { prisma } from "../src/lib/db";
import { registerPatient } from "../src/lib/patient/registration";
import { openEncounter } from "../src/lib/hospital/encounter";
import { placeLabOrder } from "../src/lib/hospital/labOrder";
import { createCharge, voidCharge } from "../src/lib/hospital/billing/chargeCapture";
import { draftInvoiceForAccount, addChargeToInvoice, issueInvoice, voidInvoice } from "../src/lib/hospital/billing/invoices";
import { recordPayment, allocatePayment, voidPayment } from "../src/lib/hospital/billing/payments";
import { requestRefund, approveRefund, completeRefund, rejectRefund } from "../src/lib/hospital/billing/refunds";
import { createAdjustment, approveAdjustment, rejectAdjustment } from "../src/lib/hospital/billing/adjustments";
import { createPayer, addPatientCoverage, deactivateCoverage } from "../src/lib/hospital/billing/coverage";
import { requestPreAuth, decidePreAuth, expirePreAuth } from "../src/lib/hospital/billing/preauth";
import { createClaimDraft, submitClaim, recordClaimDecision, settleClaim, closeClaim } from "../src/lib/hospital/billing/claims";
import { runTick } from "../src/lib/runner/tick";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const rejects = <T>(p: Promise<T>) => p.then(() => false, () => true);
const drain = async () => { for (let i = 0; i < 5; i++) if (!(await runTick({ budgetMs: 20_000 })).moreWork) break; };

type Payload = Record<string, unknown>;
const events = (type: string, aggregateId: string) =>
  prisma.domainEventOutbox.findMany({ where: { eventType: type, aggregateId }, orderBy: { seq: "asc" } });
const payloads = async (type: string, aggregateId: string) => (await events(type, aggregateId)).map((e) => e.payload as Payload);
const moves = async (type: string, aggregateId: string) => (await payloads(type, aggregateId)).map((p) => `${p.from}>${p.to}`).join(",");

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const doctor = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(facilityId), { user: { role: "DOCTOR" } }] }, orderBy: { id: "asc" } });
  const checker = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(facilityId), { user: { role: { in: ["HOSPITAL_ADMIN", "BILLING_STAFF"] } } }] }, orderBy: { id: "asc" } });
  const by = doctor.userId;
  const patient = await registerPatient({ facilityId, byUserId: by, fullName: `Billing Events ${run}`, sex: "F", ageYears: 52 });
  const enc = await openEncounter({ facilityId, patientId: patient.id, type: "IPD", chiefComplaint: "Billing events", byUserId: by });
  await drain();
  const secret = `free text ${run}`; // given to every call that takes text; must never reach a payload
  const allPayloads: Payload[] = [];
  const keep = async (type: string, aggregateId: string) => { const ps = await payloads(type, aggregateId); allPayloads.push(...ps); return ps; };

  // 1. Charges.
  const manual = await prisma.$transaction((tx) => createCharge(tx, {
    encounterId: enc.id, patientId: patient.id, facilityId, description: `Dressing ${secret}`, category: "NURSING", unitPriceMinor: 25_000, postedByUserId: by,
  }));
  const posted = await keep("ChargePosted", manual.charge.id);
  const posted0 = (await events("ChargePosted", manual.charge.id))[0];
  report("A manual charge emits ChargePosted (category, amount, PRICED, not late), correlated by the encounter",
    posted.length === 1 && posted[0].category === "NURSING" && posted[0].netAmountMinor === 25_000 && posted[0].pricingStatus === "PRICED"
      && posted[0].isLate === false && posted0.correlationId === enc.id && posted0.actorUserId === by);
  const lab = await placeLabOrder({ facilityId, staffId: doctor.id, byUserId: by, encounterId: enc.id, patientId: patient.id, testName: `CBC ${run}`, category: "Haematology" });
  const labCharge = await prisma.charge.findFirstOrThrow({ where: { sourceType: "LabOrder", sourceId: lab.order.id } });
  const labPosted = await keep("ChargePosted", labCharge.id);
  report("The in-transaction lab charge emits ChargePosted with its source (LabOrder)",
    labPosted.length === 1 && labPosted[0].category === "LAB" && labPosted[0].sourceType === "LabOrder" && labPosted[0].sourceId === lab.order.id);
  report("A charge with an unknown category is refused",
    await rejects(prisma.$transaction((tx) => createCharge(tx, { encounterId: enc.id, patientId: patient.id, facilityId, description: "x", category: "misc", unitPriceMinor: 1 }))));
  const extra = await prisma.$transaction((tx) => createCharge(tx, { encounterId: enc.id, patientId: patient.id, facilityId, description: "Duplicate entry", category: "OTHER", unitPriceMinor: 5_000, postedByUserId: by }));
  await prisma.$transaction((tx) => voidCharge(tx, extra.charge.id, { reason: `Entered twice ${secret}`, byUserId: by }));
  const voided = await keep("ChargeVoided", extra.charge.id);
  report("voidCharge emits ChargeVoided (amount, no reason)", voided.length === 1 && voided[0].netAmountMinor === 5_000);

  // 2. Invoices.
  const invoice = await prisma.$transaction(async (tx) => {
    const inv = await draftInvoiceForAccount(tx, { encounterId: enc.id, patientId: patient.id, facilityId, generatedByUserId: by });
    for (const c of [manual.charge.id, labCharge.id]) await addChargeToInvoice(tx, inv.id, c);
    return issueInvoice(tx, inv.id, { byUserId: by });
  });
  const issued = await keep("HospitalInvoiceIssued", invoice.id);
  report("issueInvoice emits HospitalInvoiceIssued (INVOICE, two lines, the total)",
    issued.length === 1 && issued[0].documentType === "INVOICE" && issued[0].lineCount === 2 && issued[0].totalMinor === invoice.totalMinor && !("supplementsInvoiceId" in issued[0]));

  const enc2 = await openEncounter({ facilityId, patientId: patient.id, type: "OPD", chiefComplaint: "Void probe", byUserId: by });
  const c2 = await prisma.$transaction((tx) => createCharge(tx, { encounterId: enc2.id, patientId: patient.id, facilityId, description: "Probe", category: "OTHER", unitPriceMinor: 1_000, postedByUserId: by }));
  await drain();
  const toVoid = await prisma.$transaction(async (tx) => {
    const inv = await draftInvoiceForAccount(tx, { encounterId: enc2.id, patientId: patient.id, facilityId, generatedByUserId: by });
    await addChargeToInvoice(tx, inv.id, c2.charge.id);
    return issueInvoice(tx, inv.id, { byUserId: by });
  });
  await prisma.$transaction((tx) => voidInvoice(tx, toVoid.id, { reason: `Wrong patient ${secret}`, byUserId: by }));
  const invVoided = await keep("HospitalInvoiceVoided", toVoid.id);
  report("voidInvoice emits HospitalInvoiceVoided from ISSUED (no reason)", invVoided.length === 1 && invVoided[0].from === "ISSUED");

  // 3. Payments.
  const key = `bce-${run}`;
  const paid = await prisma.$transaction((tx) => recordPayment(tx, { encounterId: enc.id, patientId: patient.id, facilityId, amountMinor: invoice.totalMinor + 10_000, method: "UPI", idempotencyKey: key, receivedByUserId: by }));
  await prisma.$transaction((tx) => recordPayment(tx, { encounterId: enc.id, patientId: patient.id, facilityId, amountMinor: invoice.totalMinor + 10_000, method: "UPI", idempotencyKey: key, receivedByUserId: by }));
  const recorded = await keep("HospitalPaymentRecorded", paid.payment.id);
  report("recordPayment emits HospitalPaymentRecorded once (the idempotent replay emits nothing)",
    recorded.length === 1 && recorded[0].method === "UPI" && recorded[0].encounterId === enc.id);
  await prisma.$transaction((tx) => allocatePayment(tx, { paymentId: paid.payment.id, invoiceId: invoice.id, amountMinor: invoice.totalMinor, allocatedByUserId: by }));
  const allocated = (await keep("HospitalPaymentStatusChanged", paid.payment.id)).filter((p) => p.change === "ALLOCATED");
  report("allocatePayment emits ALLOCATED with the amount and the invoice's new status (PAID)",
    allocated.length === 1 && allocated[0].invoiceId === invoice.id && allocated[0].amountMinor === invoice.totalMinor && allocated[0].invoiceStatus === "PAID");
  const stray = await prisma.$transaction((tx) => recordPayment(tx, { encounterId: enc.id, patientId: patient.id, facilityId, amountMinor: 500, method: "CASH", idempotencyKey: `${key}-stray`, receivedByUserId: by }));
  await prisma.$transaction((tx) => voidPayment(tx, stray.payment.id, { reason: `Mistake ${secret}`, byUserId: by }));
  const payVoided = (await keep("HospitalPaymentStatusChanged", stray.payment.id)).filter((p) => p.change === "VOIDED");
  report("voidPayment emits VOIDED", payVoided.length === 1 && payVoided[0].status === "VOIDED");

  // 4. Refunds (the 10 000 left on the payment) and adjustments.
  const r1 = await prisma.$transaction((tx) => requestRefund(tx, { paymentId: paid.payment.id, amountMinor: 4_000, reason: `Overpaid ${secret}`, requestedByUserId: by, idempotencyKey: `${key}-r1` }));
  const r2 = await prisma.$transaction((tx) => requestRefund(tx, { paymentId: paid.payment.id, amountMinor: 1_000, reason: `Overpaid ${secret}`, requestedByUserId: by, idempotencyKey: `${key}-r2` }));
  await prisma.$transaction((tx) => approveRefund(tx, r1.refund.id, { approvedByUserId: checker.userId }));
  report("Requesting and approving a refund emit nothing (process steps)", (await events("HospitalRefundStatusChanged", r1.refund.id)).length === 0);
  await prisma.$transaction((tx) => completeRefund(tx, r1.refund.id, { byUserId: checker.userId }));
  await prisma.$transaction((tx) => rejectRefund(tx, r2.refund.id, { byUserId: checker.userId }));
  const refundEvents = [...await keep("HospitalRefundStatusChanged", r1.refund.id), ...await keep("HospitalRefundStatusChanged", r2.refund.id)];
  const rejectRow = (await events("HospitalRefundStatusChanged", r2.refund.id))[0];
  report("completeRefund and rejectRefund emit APPROVED>COMPLETED and REQUESTED>REJECTED, by the deciding user",
    refundEvents.map((p) => `${p.from}>${p.to}`).join() === "APPROVED>COMPLETED,REQUESTED>REJECTED" && rejectRow?.actorUserId === checker.userId);
  const a1 = await prisma.$transaction((tx) => createAdjustment(tx, { invoiceId: invoice.id, type: "DISCOUNT", amountMinor: 1_000, reason: `Goodwill ${secret}`, requestedByUserId: by }));
  const a2 = await prisma.$transaction((tx) => createAdjustment(tx, { invoiceId: invoice.id, type: "WRITE_OFF", amountMinor: 2_000, reason: `Write off ${secret}`, requestedByUserId: by }));
  await prisma.$transaction((tx) => approveAdjustment(tx, a1.id, { approvedByUserId: checker.userId }));
  await prisma.$transaction((tx) => rejectAdjustment(tx, a2.id, { byUserId: checker.userId }));
  const adj = [...await keep("BillingAdjustmentStatusChanged", a1.id), ...await keep("BillingAdjustmentStatusChanged", a2.id)];
  report("approveAdjustment / rejectAdjustment emit PENDING>APPROVED (DISCOUNT) and PENDING>REJECTED (WRITE_OFF)",
    adj.map((p) => `${p.adjustmentType}:${p.from}>${p.to}`).join() === "DISCOUNT:PENDING>APPROVED,WRITE_OFF:PENDING>REJECTED");

  // 5. Coverage and pre-authorization.
  const payer = await prisma.$transaction((tx) => createPayer(tx, { name: `Gate Insurer ${run}`, type: "INSURANCE" }));
  const coverage = await prisma.$transaction((tx) => addPatientCoverage(tx, { patientId: patient.id, payerId: payer.id, memberId: `M-${run}`, validFrom: new Date(Date.now() - 86_400_000), addedByUserId: by }));
  const pre = await prisma.$transaction((tx) => requestPreAuth(tx, { coverageId: coverage.id, encounterId: enc.id, requestedAmountMinor: 100_000, requestedByUserId: by, notes: `Notes ${secret}` }));
  await prisma.$transaction((tx) => decidePreAuth(tx, pre.id, { status: "APPROVED", approvedAmountMinor: 80_000, byUserId: checker.userId }));
  const decided = await keep("PreauthDecided", pre.id);
  report("requestPreAuth → PreauthStatusChanged null>REQUESTED; decidePreAuth → PreauthDecided (APPROVED, 80 000)",
    (await moves("PreauthStatusChanged", pre.id)) === "null>REQUESTED" && decided.length === 1 && decided[0].decision === "APPROVED" && decided[0].approvedAmountMinor === 80_000);
  const pre2 = await prisma.$transaction((tx) => requestPreAuth(tx, { coverageId: coverage.id, encounterId: enc.id, requestedAmountMinor: 5_000, requestedByUserId: by }));
  await prisma.$transaction((tx) => expirePreAuth(tx, pre2.id, { byUserId: by }));
  report("expirePreAuth → PreauthStatusChanged REQUESTED>EXPIRED", (await moves("PreauthStatusChanged", pre2.id)) === "null>REQUESTED,REQUESTED>EXPIRED");
  allPayloads.push(...await payloads("PreauthStatusChanged", pre.id));

  // 6. Claims (direct).
  const claim = await prisma.$transaction((tx) => createClaimDraft(tx, { invoiceId: invoice.id, coverageId: coverage.id, preAuthorizationId: pre.id, facilityId, createdByUserId: by }));
  const drafted = await keep("ClaimDrafted", claim.id);
  report("createClaimDraft → ClaimDrafted (invoice, coverage, pre-authorization, amount)",
    drafted.length === 1 && drafted[0].invoiceId === invoice.id && drafted[0].coverageId === coverage.id && drafted[0].preAuthId === pre.id && drafted[0].submittedAmountMinor === claim.submittedAmountMinor);
  await prisma.$transaction((tx) => submitClaim(tx, claim.id, { byUserId: by }));
  const submitted = await keep("ClaimSubmitted", claim.id);
  report("submitClaim → ClaimSubmitted (DIRECT)", submitted.length === 1 && submitted[0].channel === "DIRECT");
  await prisma.$transaction((tx) => recordClaimDecision(tx, claim.id, { status: "UNDER_REVIEW", byUserId: by }));
  await prisma.$transaction((tx) => recordClaimDecision(tx, claim.id, { status: "PARTIALLY_APPROVED", approvedAmountMinor: 20_000, byUserId: by }));
  await prisma.$transaction((tx) => settleClaim(tx, claim.id, { settledAmountMinor: 20_000, byUserId: by }));
  await prisma.$transaction((tx) => closeClaim(tx, claim.id, { byUserId: by }));
  allPayloads.push(...await payloads("ClaimStatusChanged", claim.id));
  report("Decisions and closure → ClaimStatusChanged SUBMITTED>UNDER_REVIEW, UNDER_REVIEW>PARTIALLY_APPROVED, SETTLED>CLOSED",
    (await moves("ClaimStatusChanged", claim.id)) === "SUBMITTED>UNDER_REVIEW,UNDER_REVIEW>PARTIALLY_APPROVED,SETTLED>CLOSED");
  const settled = await keep("ClaimSettled", claim.id);
  report("settleClaim → ClaimSettled (stage SETTLED, 20 000, no settlement row)",
    settled.length === 1 && settled[0].stage === "SETTLED" && settled[0].settledAmountMinor === 20_000 && !("settlementId" in settled[0]));
  const rejected = await prisma.$transaction(async (tx) => {
    const c3 = await createCharge(tx, { encounterId: enc2.id, patientId: patient.id, facilityId, description: "Probe 2", category: "OTHER", unitPriceMinor: 2_000, postedByUserId: by });
    const inv = await draftInvoiceForAccount(tx, { encounterId: enc2.id, patientId: patient.id, facilityId, generatedByUserId: by });
    await addChargeToInvoice(tx, inv.id, c3.charge.id);
    return issueInvoice(tx, inv.id, { byUserId: by });
  }).then((inv) => prisma.$transaction(async (tx) => {
    const c = await createClaimDraft(tx, { invoiceId: inv.id, coverageId: coverage.id, facilityId, createdByUserId: by });
    await submitClaim(tx, c.id, { byUserId: by });
    return recordClaimDecision(tx, c.id, { status: "REJECTED", denialReason: `Not covered ${secret}`, byUserId: by });
  }));
  allPayloads.push(...await payloads("ClaimStatusChanged", rejected.id));
  report("A rejection → ClaimStatusChanged SUBMITTED>REJECTED (no denial text)", (await moves("ClaimStatusChanged", rejected.id)) === "SUBMITTED>REJECTED");

  await prisma.$transaction((tx) => deactivateCoverage(tx, coverage.id, { byUserId: by }));
  await prisma.$transaction((tx) => deactivateCoverage(tx, coverage.id, { byUserId: by }));
  allPayloads.push(...await payloads("CoverageStatusChanged", coverage.id));
  report("Coverage: null>ACTIVE, ACTIVE>INACTIVE; deactivating again emits nothing", (await moves("CoverageStatusChanged", coverage.id)) === "null>ACTIVE,ACTIVE>INACTIVE");

  // 7. No free text.
  report("No billing payload carries the text the calls were given", allPayloads.length > 20 && !JSON.stringify(allPayloads).includes("free text"), `${allPayloads.length} payloads`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
