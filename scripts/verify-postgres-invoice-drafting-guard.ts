/**
 * Workflow spine design risk #2: charge-capture posts some charges a moment
 * after their event, so invoicing waits for it.
 *
 *   1. A completed procedure not yet charged: drafting is refused
 *      (ChargesPendingError); once charge-capture runs, the draft carries it.
 *   2. Issuing is refused the same way while another charge is on its way.
 *   3. So is drafting a supplementary invoice.
 *   4. Only charge-capture's work blocks: a trigger event it has processed
 *      (another consumer still retrying) or dead-lettered does not.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-invoice-drafting-guard.ts
 */
import { prisma } from "../src/lib/db";
import { registerPatient } from "../src/lib/patient/registration";
import { openEncounter } from "../src/lib/hospital/encounter";
import { requestSurgery, transitionSurgery, scheduleSurgery, startProcedure, completeProcedure, createOperatingTheatre } from "../src/lib/hospital/surgery";
import { draftInvoiceForAccount, addChargeToInvoice, issueInvoice, draftSupplementaryInvoice, ChargesPendingError } from "../src/lib/hospital/billing/invoices";
import { createCharge } from "../src/lib/hospital/billing/chargeCapture";
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
const pendingError = <T>(p: Promise<T>) => p.then(() => false, (e) => e instanceof ChargesPendingError);

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const doctor = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(facilityId), { user: { role: "DOCTOR" } }] }, orderBy: { id: "asc" } });
  const by = doctor.userId;
  const patient = await registerPatient({ facilityId, byUserId: by, fullName: `Drafting Guard ${run}`, sex: "F", ageYears: 58 });
  const enc = await openEncounter({ facilityId, patientId: patient.id, type: "IPD", chiefComplaint: "Guard", byUserId: by });
  await drain();
  const ot = await createOperatingTheatre({ facilityId, name: `Guard OT ${run}`, byUserId: by });
  let slot = 0;
  const surgery = async (name: string) => {
    const s = await requestSurgery({ facilityId, patientId: patient.id, encounterId: enc.id, procedureName: `${name} ${run}`, requestedByStaffId: doctor.id, byUserId: by });
    await transitionSurgery({ surgeryId: s.id, facilityId, to: "REVIEWED", actorStaffId: doctor.id, byUserId: by });
    await transitionSurgery({ surgeryId: s.id, facilityId, to: "APPROVED", actorStaffId: doctor.id, byUserId: by });
    const at = new Date(Date.now() + (4 + slot++) * 86_400_000 + Math.floor(Math.random() * 600) * 60_000);
    await scheduleSurgery({ surgeryId: s.id, facilityId, operatingTheatreId: ot.id, startAt: at, endAt: new Date(at.getTime() + 3_600_000), schedulerStaffId: doctor.id, byUserId: by });
    await startProcedure({ surgeryId: s.id, facilityId, byUserId: by });
    await drain();
    await completeProcedure({ surgeryId: s.id, facilityId, byUserId: by }); // ProcedureCompleted, not yet charged
    return s;
  };
  const draft = () => prisma.$transaction((tx) => draftInvoiceForAccount(tx, { encounterId: enc.id, patientId: patient.id, facilityId, generatedByUserId: by }));

  // 1. Drafting waits.
  const s1 = await surgery("First");
  report("A completed procedure not yet charged: drafting is refused (charges pending)", await pendingError(draft()));
  await drain();
  const charge1 = await prisma.charge.findFirstOrThrow({ where: { sourceType: "Surgery", sourceId: s1.id } });
  const inv = await draft();
  await prisma.$transaction((tx) => addChargeToInvoice(tx, inv.id, charge1.id));
  report("Once charge-capture has run, the draft carries the procedure charge", (await prisma.invoiceLine.count({ where: { invoiceId: inv.id, chargeId: charge1.id } })) === 1);

  // 2. Issuing waits.
  const s2 = await surgery("Second");
  report("Issuing is refused while another charge is on its way", await pendingError(prisma.$transaction((tx) => issueInvoice(tx, inv.id, { byUserId: by }))));
  await drain();
  const charge2 = await prisma.charge.findFirstOrThrow({ where: { sourceType: "Surgery", sourceId: s2.id } });
  await prisma.$transaction((tx) => addChargeToInvoice(tx, inv.id, charge2.id));
  const issued = await prisma.$transaction((tx) => issueInvoice(tx, inv.id, { byUserId: by }));
  report("…and issues once it has arrived, with both charges", issued.status === "ISSUED" && issued.lines.length === 2);

  // 3. Supplementary drafting waits.
  await prisma.$transaction((tx) => createCharge(tx, { encounterId: enc.id, patientId: patient.id, facilityId, description: "Late dressing", category: "NURSING", unitPriceMinor: 2_000, postedByUserId: by }));
  await surgery("Third");
  report("Drafting a supplementary invoice is refused while a charge is on its way",
    await pendingError(prisma.$transaction((tx) => draftSupplementaryInvoice(tx, { originalInvoiceId: issued.id, generatedByUserId: by }))));
  await drain();
  const sup = await prisma.$transaction((tx) => draftSupplementaryInvoice(tx, { originalInvoiceId: issued.id, generatedByUserId: by }));
  report("…and collects both late charges once it has", sup.lines.length === 2);

  // 4. Only charge-capture's own work blocks.
  const trigger = await prisma.domainEventOutbox.findFirstOrThrow({ where: { correlationId: enc.id, eventType: "ProcedureCompleted" }, orderBy: { seq: "desc" } });
  await prisma.domainEventOutbox.update({ where: { eventId: trigger.eventId }, data: { status: "RETRY" } });
  /** Would drafting be allowed? Drafts in a transaction that is then rolled back. */
  const ROLLBACK = new Error("rollback");
  const enc2Inv = async () => prisma.$transaction(async (tx) => {
    await draftInvoiceForAccount(tx, { encounterId: enc.id, patientId: patient.id, facilityId, generatedByUserId: by });
    throw ROLLBACK;
  }).catch((e) => (e === ROLLBACK ? true : e));
  report("A trigger charge-capture has processed does not block (another consumer still retrying)", (await enc2Inv()) === true);
  await prisma.domainEventDelivery.update({ where: { eventId_consumerName: { eventId: trigger.eventId, consumerName: "charge-capture" } }, data: { status: "DEAD_LETTER" } });
  report("…nor one it dead-lettered (visible in the dead-letter list instead)", (await enc2Inv()) === true);
  await prisma.domainEventDelivery.update({ where: { eventId_consumerName: { eventId: trigger.eventId, consumerName: "charge-capture" } }, data: { status: "PENDING" } });
  report("…but one it has still to process does", (await enc2Inv()) instanceof ChargesPendingError);
  await prisma.domainEventDelivery.update({ where: { eventId_consumerName: { eventId: trigger.eventId, consumerName: "charge-capture" } }, data: { status: "PROCESSED" } });
  await prisma.domainEventOutbox.update({ where: { eventId: trigger.eventId }, data: { status: "PROCESSED" } });

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
