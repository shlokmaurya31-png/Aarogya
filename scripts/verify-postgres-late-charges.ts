/**
 * Batch 5, decision 2: a charge posted after the encounter's invoice is issued
 * is recorded normally, marked late, raises one billing exception task, and is
 * collected on a supplementary document linked to the original. Issued
 * invoices are never edited.
 *
 *   1. Invoice issued → a late SURGICAL charge (charge-capture, after the
 *      procedure completes) → recorded, isLate, one LATE_CHARGE task.
 *   2. A late in-transaction charge (a lab order) is marked late the same way.
 *   3. The original invoice is unchanged (lines, total).
 *   4. draftSupplementaryInvoice collects exactly the late charges onto a
 *      SUPPLEMENTARY_INVOICE linked to the original; issuing it numbers it
 *      SUP-… and closes the LATE_CHARGE tasks.
 *   5. Total charged exactly once: every posted charge is on exactly one
 *      issued document, and the documents' totals add up to the charges.
 *   6. A facility configured with DEBIT_NOTE gets a debit note (DN-…).
 *   7. Guards: no supplement of a draft or of a supplementary document; none
 *      without un-invoiced charges.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-late-charges.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerPatient } from "../src/lib/patient/registration";
import { openEncounter } from "../src/lib/hospital/encounter";
import { placeLabOrder } from "../src/lib/hospital/labOrder";
import { requestSurgery, transitionSurgery, scheduleSurgery, startProcedure, completeProcedure, createOperatingTheatre } from "../src/lib/hospital/surgery";
import { draftInvoiceForAccount, addChargeToInvoice, issueInvoice, draftSupplementaryInvoice } from "../src/lib/hospital/billing/invoices";
import { setOverride, publishOverride } from "../src/lib/config/overrides";
import { loadActorMemberships } from "../src/lib/auth/tenantContext";
import { runTick } from "../src/lib/runner/tick";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const drain = async () => { for (let i = 0; i < 5; i++) if (!(await runTick({ budgetMs: 20_000 })).moreWork) break; };
const rejects = <T>(p: Promise<T>) => p.then(() => false, () => true);

/** Draft an invoice with every un-invoiced charge of the encounter and issue it. */
async function invoiceEverything(encounterId: string, patientId: string, facilityId: string, by: string) {
  return prisma.$transaction(async (tx) => {
    const inv = await draftInvoiceForAccount(tx, { encounterId, patientId, facilityId, generatedByUserId: by });
    for (const c of await tx.charge.findMany({ where: { encounterId, status: "POSTED", invoiceLine: null }, select: { id: true } })) await addChargeToInvoice(tx, inv.id, c.id);
    return issueInvoice(tx, inv.id, {});
  });
}

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const doctor = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(facilityId), { user: { role: "DOCTOR" } }] }, orderBy: { id: "asc" } });
  const by = doctor.userId;
  const patient = await registerPatient({ facilityId, byUserId: by, fullName: `Late Charge ${run}`, sex: "F", ageYears: 39 });
  const enc = await openEncounter({ facilityId, patientId: patient.id, type: "IPD", chiefComplaint: "Surgery", byUserId: by });

  // An approved, scheduled, started surgery and one lab order, invoiced before the procedure completes.
  const ot = await createOperatingTheatre({ facilityId, name: `LC OT ${run}`, byUserId: by });
  const s = await requestSurgery({ facilityId, patientId: patient.id, encounterId: enc.id, procedureName: "Hernia repair", requestedByStaffId: doctor.id, byUserId: by });
  await transitionSurgery({ surgeryId: s.id, facilityId, to: "REVIEWED", actorStaffId: doctor.id, byUserId: by });
  await transitionSurgery({ surgeryId: s.id, facilityId, to: "APPROVED", actorStaffId: doctor.id, byUserId: by });
  const at = new Date(Date.now() + 3 * 86_400_000 + Math.floor(Math.random() * 600) * 60_000);
  await scheduleSurgery({ surgeryId: s.id, facilityId, operatingTheatreId: ot.id, startAt: at, endAt: new Date(at.getTime() + 3_600_000), schedulerStaffId: doctor.id, byUserId: by });
  await startProcedure({ surgeryId: s.id, facilityId, byUserId: by });
  await placeLabOrder({ facilityId, staffId: doctor.id, byUserId: by, encounterId: enc.id, patientId: patient.id, testName: `CBC ${run}`, category: "Haematology" });
  await drain();
  const original = await invoiceEverything(enc.id, patient.id, facilityId, by);
  const originalLines = original.lines.length;
  report("The original invoice is issued", original.status === "ISSUED" && original.documentType === "INVOICE" && originalLines >= 1);

  // 1. A late surgical charge.
  await completeProcedure({ surgeryId: s.id, facilityId, byUserId: by });
  await drain();
  const surgical = await prisma.charge.findFirstOrThrow({ where: { sourceType: "Surgery", sourceId: s.id } });
  const task = (id: string) => prisma.task.findUnique({ where: { facilityId_idempotencyKey: { facilityId, idempotencyKey: `LATE_CHARGE:${id}` } } });
  report("A surgical charge arriving after the invoice is recorded normally and marked late", surgical.status === "POSTED" && surgical.isLate && surgical.netAmountMinor > 0);
  report("…with one billing exception task (LATE_CHARGE, for billing)", (await task(surgical.id))?.status === "OPEN" && (await task(surgical.id))?.assignedRole === "BILLING_STAFF");
  const delivery = await prisma.domainEventDelivery.findFirst({ where: { consumerName: "charge-capture", event: { eventType: "ProcedureCompleted", aggregateId: s.id } } });
  report("…and charge-capture processed it (no ENCOUNTER_INVOICED dead letter)", delivery?.status === "PROCESSED", delivery?.status);

  // 2. A late in-transaction charge.
  const lab = await placeLabOrder({ facilityId, staffId: doctor.id, byUserId: by, encounterId: enc.id, patientId: patient.id, testName: `LFT ${run}`, category: "Biochemistry" });
  const labCharge = await prisma.charge.findFirstOrThrow({ where: { sourceType: "LabOrder", sourceId: lab.order.id } });
  report("A late in-transaction charge (lab order) is marked late too, with its task", labCharge.isLate && (await task(labCharge.id))?.status === "OPEN");

  // 3. The original is untouched.
  const originalNow = await prisma.invoice.findUniqueOrThrow({ where: { id: original.id }, include: { lines: true } });
  report("The issued invoice is never edited", originalNow.lines.length === originalLines && originalNow.totalMinor === original.totalMinor && originalNow.status === "ISSUED");

  // 4. The supplementary invoice.
  const sup = await prisma.$transaction((tx) => draftSupplementaryInvoice(tx, { originalInvoiceId: original.id, generatedByUserId: by }));
  report("draftSupplementaryInvoice collects exactly the late charges, linked to the original",
    sup.documentType === "SUPPLEMENTARY_INVOICE" && sup.supplementsInvoiceId === original.id
      && sup.lines.map((l) => l.chargeId).sort().join() === [surgical.id, labCharge.id].sort().join());
  const supIssued = await prisma.$transaction((tx) => issueInvoice(tx, sup.id, {}));
  report("Issuing it numbers it SUP-… and closes the LATE_CHARGE tasks",
    supIssued.invoiceNumber!.startsWith("SUP-") && (await task(surgical.id))?.status === "COMPLETED" && (await task(labCharge.id))?.status === "COMPLETED");
  const lateEvents = await prisma.domainEventOutbox.findMany({ where: { eventType: "ChargePosted", aggregateId: { in: [surgical.id, labCharge.id] } } });
  report("ChargePosted marks both late charges isLate",
    lateEvents.length === 2 && lateEvents.every((e) => (e.payload as { isLate?: boolean }).isLate === true));
  const supEvent = await prisma.domainEventOutbox.findMany({ where: { eventType: "HospitalInvoiceIssued", aggregateId: sup.id } });
  const sp = supEvent[0]?.payload as { documentType?: string; supplementsInvoiceId?: string; lineCount?: number } | undefined;
  report("HospitalInvoiceIssued for the supplementary invoice names its type and the original",
    supEvent.length === 1 && sp?.documentType === "SUPPLEMENTARY_INVOICE" && sp.supplementsInvoiceId === original.id && sp.lineCount === 2);

  // 5. Charged exactly once.
  const charges = await prisma.charge.findMany({ where: { encounterId: enc.id, status: "POSTED" }, include: { invoiceLine: true } });
  const docs = await prisma.invoice.findMany({ where: { encounterId: enc.id, status: { not: "VOID" } } });
  const chargedTotal = charges.reduce((a, c) => a + c.netAmountMinor, 0);
  const billedTotal = docs.reduce((a, d) => a + d.totalMinor, 0);
  report("Total charged exactly once: every charge on one line, and the documents add up to the charges",
    charges.every((c) => c.invoiceLine) && docs.length === 2 && billedTotal === chargedTotal, `charged ${chargedTotal}, billed ${billedTotal}`);

  // 6. DEBIT_NOTE by facility configuration (Noida).
  const noida = "fac-amc-noida";
  const nDoctor = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(noida), { user: { role: "DOCTOR" } }] }, orderBy: { id: "asc" } });
  const admin = await prisma.user.findFirstOrThrow({ where: { role: "AAROGYA_ADMIN" }, orderBy: { id: "asc" } });
  const platform = await loadActorMemberships(admin.id, "AAROGYA_ADMIN");
  const org = (await prisma.facility.findUniqueOrThrow({ where: { id: noida }, select: { organizationId: true } })).organizationId;
  const scope = { scope: "FACILITY" as const, organizationId: org, facilityId: noida, key: "billing.late_charge.document_type" };
  await setOverride(platform, { ...scope, value: "DEBIT_NOTE", reason: "late-charges gate" });
  await publishOverride(platform, { ...scope, reason: "late-charges gate" });
  const nPatient = await registerPatient({ facilityId: noida, byUserId: nDoctor.userId, fullName: `Late Charge N ${run}`, sex: "M", ageYears: 50 });
  const nEnc = await openEncounter({ facilityId: noida, patientId: nPatient.id, type: "OPD", chiefComplaint: "Review", byUserId: nDoctor.userId });
  await placeLabOrder({ facilityId: noida, staffId: nDoctor.id, byUserId: nDoctor.userId, encounterId: nEnc.id, patientId: nPatient.id, testName: `TSH ${run}`, category: "Endocrine" });
  await drain();
  const nOriginal = await invoiceEverything(nEnc.id, nPatient.id, noida, nDoctor.userId);
  await placeLabOrder({ facilityId: noida, staffId: nDoctor.id, byUserId: nDoctor.userId, encounterId: nEnc.id, patientId: nPatient.id, testName: `T4 ${run}`, category: "Endocrine" });
  const dn = await prisma.$transaction(async (tx) => issueInvoice(tx, (await draftSupplementaryInvoice(tx, { originalInvoiceId: nOriginal.id, generatedByUserId: nDoctor.userId })).id, {}));
  report("A facility configured DEBIT_NOTE collects late charges on a debit note (DN-…)", dn.documentType === "DEBIT_NOTE" && dn.invoiceNumber!.startsWith("DN-") && dn.supplementsInvoiceId === nOriginal.id);

  // 7. Guards.
  const draftOnly = await prisma.$transaction((tx) => draftInvoiceForAccount(tx, { encounterId: enc.id, patientId: patient.id, facilityId, generatedByUserId: by }));
  report("No supplement of a draft, of a supplementary document, or with nothing to collect",
    await rejects(prisma.$transaction((tx) => draftSupplementaryInvoice(tx, { originalInvoiceId: draftOnly.id, generatedByUserId: by })))
      && await rejects(prisma.$transaction((tx) => draftSupplementaryInvoice(tx, { originalInvoiceId: sup.id, generatedByUserId: by })))
      && await rejects(prisma.$transaction((tx) => draftSupplementaryInvoice(tx, { originalInvoiceId: original.id, generatedByUserId: by }))));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
