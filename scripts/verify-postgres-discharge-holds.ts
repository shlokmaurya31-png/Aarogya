/**
 * Batch 6, fix 1: manual discharge holds.
 *
 *   1. Placing a BILLING hold emits DischargeHoldChanged (PLACED, the code);
 *      a second active BILLING hold is refused.
 *   2. A payment event arrives: discharge-readiness raises billingReady, the
 *      hold stays active, the barrier list leads with it, and with every flag
 *      set finalizeDischarge is still refused.
 *   3. Clearing the hold emits CLEARED (who and when recorded); clearing again
 *      is refused; the discharge then proceeds.
 *   4. A discharged patient can't be put on hold; a hold racing finalize never
 *      lands on a discharged patient.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-discharge-holds.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerPatient } from "../src/lib/patient/registration";
import { openEncounter } from "../src/lib/hospital/encounter";
import { admitPatient, initiateDischarge, updateDischargeReadiness, finalizeDischarge } from "../src/lib/hospital/admission";
import { placeDischargeHold, clearDischargeHold, DischargeOnHoldError } from "../src/lib/hospital/dischargeHold";
import { computeDischargeBarriers } from "../src/lib/hospital/dischargeBarrierEngine";
import { createCharge } from "../src/lib/hospital/billing/chargeCapture";
import { draftInvoiceForAccount, addChargeToInvoice, issueInvoice } from "../src/lib/hospital/billing/invoices";
import { recordPayment, allocatePayment } from "../src/lib/hospital/billing/payments";
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
const rejects = <T>(p: Promise<T>) => p.then(() => false, () => true);

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const doctor = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(facilityId), { user: { role: "DOCTOR" } }] }, orderBy: { id: "asc" } });
  const by = doctor.userId;
  const ward = await prisma.ward.create({ data: { facilityId, name: `Hold ward ${run}`, wardType: "GENERAL" } });
  let n = 0;
  const admitted = async () => {
    const patient = await registerPatient({ facilityId, byUserId: by, fullName: `Discharge Hold ${run} ${++n}`, sex: "F", ageYears: 66 });
    const enc = await openEncounter({ facilityId, patientId: patient.id, type: "IPD", chiefComplaint: "Hold", byUserId: by });
    const bed = await prisma.bed.create({ data: { facilityId, wardId: ward.id, label: `HOLD-${run}-${n}` } });
    const admission = await admitPatient({ encounterId: enc.id, bedId: bed.id, admittingStaffId: doctor.id, reason: "hold", admissionType: "ELECTIVE", byUserId: by });
    const discharge = await initiateDischarge(admission.id, by, doctor.id);
    await drain();
    return { patient, enc, discharge };
  };

  // 1. Place.
  const a = await admitted();
  const hold = await placeDischargeHold({ dischargeId: a.discharge.id, facilityId, reasonCode: "BILLING", byUserId: by });
  const placed = await prisma.domainEventOutbox.findMany({ where: { eventType: "DischargeHoldChanged", aggregateId: a.discharge.id }, orderBy: { seq: "asc" } });
  const pp = placed[0]?.payload as { change?: string; reasonCode?: string; holdId?: string } | undefined;
  report("Placing a BILLING hold emits DischargeHoldChanged (PLACED, BILLING), correlated by the encounter",
    placed.length === 1 && pp?.change === "PLACED" && pp.reasonCode === "BILLING" && pp.holdId === hold.id && placed[0].correlationId === a.enc.id && hold.placedByUserId === by);
  report("A second active BILLING hold is refused", await rejects(placeDischargeHold({ dischargeId: a.discharge.id, facilityId, reasonCode: "BILLING", byUserId: by })));

  // 2. A payment event arrives.
  const charge = await prisma.$transaction((tx) => createCharge(tx, { encounterId: a.enc.id, patientId: a.patient.id, facilityId, description: "Stay", category: "NURSING", unitPriceMinor: 20_000, postedByUserId: by }));
  await drain();
  const inv = await prisma.$transaction(async (tx) => {
    const d = await draftInvoiceForAccount(tx, { encounterId: a.enc.id, patientId: a.patient.id, facilityId, generatedByUserId: by });
    await addChargeToInvoice(tx, d.id, charge.charge.id);
    return issueInvoice(tx, d.id, { byUserId: by });
  });
  const pay = await prisma.$transaction((tx) => recordPayment(tx, { encounterId: a.enc.id, patientId: a.patient.id, facilityId, amountMinor: inv.totalMinor, method: "CARD", idempotencyKey: `hold-${run}`, receivedByUserId: by }));
  await prisma.$transaction((tx) => allocatePayment(tx, { paymentId: pay.payment.id, invoiceId: inv.id, amountMinor: inv.totalMinor, allocatedByUserId: by }));
  await drain();
  const d1 = await prisma.discharge.findUniqueOrThrow({ where: { id: a.discharge.id } });
  const h1 = await prisma.dischargeHold.findUniqueOrThrow({ where: { id: hold.id } });
  report("The payment raises billingReady (derived), and the hold stays active", d1.billingReady && h1.clearedAt === null);
  const barriers = await computeDischargeBarriers(a.discharge.id);
  report("The barrier list leads with the hold", barriers[0]?.code === "HOLD" && barriers[0].blocked);
  await updateDischargeReadiness(a.discharge.id, { clinicallyReady: true, documentationReady: true, billingReady: true, insuranceReady: true, pharmacyReady: true, transportReady: true });
  report("With every flag set, finalizeDischarge is refused while the hold is active",
    await finalizeDischarge(a.discharge.id, by, { summary: "hold" }).then(() => false, (e) => e instanceof DischargeOnHoldError));
  report("…and nothing moved (still not discharged)", (await prisma.discharge.findUniqueOrThrow({ where: { id: a.discharge.id } })).dischargedAt === null);

  // 3. Clear.
  const cleared = await clearDischargeHold({ holdId: hold.id, facilityId, byUserId: doctor.userId });
  const changes = (await prisma.domainEventOutbox.findMany({ where: { eventType: "DischargeHoldChanged", aggregateId: a.discharge.id }, orderBy: { seq: "asc" } })).map((e) => (e.payload as { change: string }).change);
  report("Clearing emits CLEARED and records who and when", changes.join() === "PLACED,CLEARED" && cleared.clearedByUserId === doctor.userId && cleared.clearedAt !== null);
  report("Clearing again is refused", await rejects(clearDischargeHold({ holdId: hold.id, facilityId, byUserId: by })));
  await finalizeDischarge(a.discharge.id, by, { summary: "hold cleared" });
  report("With the hold cleared, the discharge proceeds", (await prisma.discharge.findUniqueOrThrow({ where: { id: a.discharge.id } })).dischargedAt !== null);

  // 4. After discharge, and racing finalize.
  report("A discharged patient can't be put on hold", await rejects(placeDischargeHold({ dischargeId: a.discharge.id, facilityId, reasonCode: "OTHER", byUserId: by })));
  let consistent = 0;
  for (let i = 0; i < 4; i++) {
    const b = await admitted();
    await updateDischargeReadiness(b.discharge.id, { clinicallyReady: true, documentationReady: true, billingReady: true, insuranceReady: true, pharmacyReady: true, transportReady: true });
    const [f, h] = await Promise.allSettled([
      finalizeDischarge(b.discharge.id, by, { summary: "race" }),
      placeDischargeHold({ dischargeId: b.discharge.id, facilityId, reasonCode: "CLINICAL", byUserId: by }),
    ]);
    const discharged = (await prisma.discharge.findUniqueOrThrow({ where: { id: b.discharge.id } })).dischargedAt !== null;
    const holds = await prisma.dischargeHold.count({ where: { dischargeId: b.discharge.id } });
    // Exactly one wins: discharged with no hold, or held and not discharged.
    if ((f.status === "fulfilled" && h.status === "rejected" && discharged && holds === 0) || (f.status === "rejected" && h.status === "fulfilled" && !discharged && holds === 1)) consistent++;
  }
  report("A hold racing finalize: exactly one wins, every time (4 races)", consistent === 4, `${consistent}/4`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
