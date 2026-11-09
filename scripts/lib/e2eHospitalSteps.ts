/**
 * Week 5 final — the hospital's side of the browser journeys
 * (e2e/ed-admission.spec.ts, e2e/medication-round.spec.ts, e2e/opd.spec.ts),
 * for the steps without a screen of their own, through the real services,
 * against the smoke database only (scripts/lib/e2eGuard.ts). Each command
 * prints one JSON line.
 *   patient <full name>        the facility record's id
 *   encounter <patientId>      the record's open encounter
 *   ed-arrival                 a new patient arrives in the ED (and a free ward bed for the admission)
 *   icu-ot <encounterId>       the admission moves to the ICU; a procedure in theatre, completed
 *   coverage <patientId>       the patient's insurance at the facility (so the bill is claimed)
 *   invoice <encounterId>      the final bill, issued (the worker drafts the claim)
 *   med-round                  an admitted patient with a dispensed medicine: a dose due now and one five hours late
 *   mar <orderId>              the order's doses and their statuses
 *   ward-device                Flagship 4d: an offline-enabled ward with a registered tablet, an admitted patient
 *                              assigned to the nurse (who is the ward's charge nurse), two doses due soon, a
 *                              controlled one, a task
 *   take-over-give <adminId>   the charge nurse takes a dose over from the tablet and gives it online
 *   ward-state <json>          the server's record: doses, vitals, the task, open conflicts
 *   scan-counter               Flagship 6: a Scan and Share counter at the facility, and its QR's path
 */
import "./e2eGuard";
import { readFileSync } from "node:fs";
import { prisma } from "../../src/lib/db";
import { registerPatient } from "../../src/lib/patient/registration";
import { registerEdArrival } from "../../src/lib/hospital/emergency";
import { transferWithinIcu } from "../../src/lib/hospital/icu";
import { createOperatingTheatre, requestSurgery, transitionSurgery, scheduleSurgery, startProcedure, completeProcedure } from "../../src/lib/hospital/surgery";
import { addPatientCoverage } from "../../src/lib/hospital/billing/coverage";
import { draftInvoiceForAccount, addChargeToInvoice, issueInvoice } from "../../src/lib/hospital/billing/invoices";
import { administerMedication, createMedicationOrder, verifyMedicationOrder, dispenseMedication } from "../../src/lib/hospital/medicationLifecycle";
import { generateAdministrationSchedule } from "../../src/lib/hospital/medicationSchedule";
import { sweepMedicationSchedule } from "../../src/lib/hospital/marSweep";
import { linkMedicationToItem, SYSTEM_ACTOR } from "../../src/lib/hospital/inventory/itemMedicationLink";
import { createAdjustment } from "../../src/lib/hospital/inventory/adjustment";
import type { E2eFixture } from "./e2eFixture";
import { PUNE } from "./e2eFixture";
import { INSURER, admissionFor } from "./insuranceFixture";
import { designateChargeNurse, overrideLease, registerWardDevice } from "../../src/lib/hospital/offline/service";
import { enableOfflineForGate } from "./offlineFixture";
import { countersWithQr, createCounter } from "../../src/lib/hospital/scanShare/service";

const out = (v: unknown) => console.log(JSON.stringify(v));

async function staffOf(email: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { email }, include: { hospitalStaffProfile: true } });
  return { userId: u.id, staffId: u.hospitalStaffProfile!.id };
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const f = JSON.parse(readFileSync(process.env.E2E_FIXTURE!, "utf8")) as E2eFixture;
  const doc = await staffOf(f.doctor.email);
  const run = `${f.tag}${Date.now().toString(36).slice(-4)}`;
  switch (cmd) {
    case "patient": {
      const p = await prisma.patient.findFirstOrThrow({ where: { facilityId: PUNE, fullName: arg }, orderBy: { createdAt: "desc" } });
      return out({ patientId: p.id });
    }
    case "encounter": {
      const e = await prisma.encounter.findFirstOrThrow({ where: { patientId: arg, closedAt: null }, orderBy: { registeredAt: "desc" } });
      return out({ encounterId: e.id });
    }
    case "ed-arrival": {
      const name = `ED Smoke ${run}`;
      const patient = await registerPatient({ facilityId: PUNE, byUserId: doc.userId, fullName: name, sex: "F", ageYears: 58 });
      const ward = await prisma.ward.create({ data: { facilityId: PUNE, name: `E2E ward ${run}`, wardType: "GENERAL" } });
      const bed = await prisma.bed.create({ data: { facilityId: PUNE, wardId: ward.id, label: `E2E-W-${run}` } });
      const enc = await registerEdArrival({ facilityId: PUNE, patientId: patient.id, chiefComplaint: "Chest pain", arrivalMode: "AMBULANCE", registeredByStaffId: doc.staffId, byUserId: doc.userId });
      return out({ name, patientId: patient.id, encounterId: enc.id, bedId: bed.id, bedLabel: bed.label });
    }
    case "icu-ot": {
      const adm = await prisma.admission.findFirstOrThrow({ where: { encounterId: arg } });
      const enc = await prisma.encounter.findUniqueOrThrow({ where: { id: arg } });
      const icu = await prisma.ward.create({ data: { facilityId: PUNE, name: `E2E ICU ${run}`, wardType: "ICU" } });
      const icuBed = await prisma.bed.create({ data: { facilityId: PUNE, wardId: icu.id, label: `E2E-I-${run}`, icuCapable: true } });
      await transferWithinIcu({ admissionId: adm.id, toBedId: icuBed.id, facilityId: PUNE, reason: "deterioration", byUserId: doc.userId });
      const proc = await prisma.procedure.findUniqueOrThrow({ where: { facilityId_code: { facilityId: PUNE, code: "PTCA" } } });
      const ot = await createOperatingTheatre({ facilityId: PUNE, name: `E2E OT ${run}`, byUserId: doc.userId });
      const s = await requestSurgery({ facilityId: PUNE, patientId: enc.patientId, encounterId: enc.id, procedureId: proc.id, urgency: "URGENT", requestedByStaffId: doc.staffId, byUserId: doc.userId });
      await transitionSurgery({ surgeryId: s.id, facilityId: PUNE, to: "REVIEWED", actorStaffId: doc.staffId, byUserId: doc.userId });
      await transitionSurgery({ surgeryId: s.id, facilityId: PUNE, to: "APPROVED", actorStaffId: doc.staffId, byUserId: doc.userId });
      const at = new Date(Date.now() + 3 * 86_400_000 + Math.floor(Math.random() * 1000) * 60_000);
      await scheduleSurgery({ surgeryId: s.id, facilityId: PUNE, operatingTheatreId: ot.id, startAt: at, endAt: new Date(at.getTime() + (proc.typicalDurationMinutes ?? 60) * 60_000), schedulerStaffId: doc.staffId, byUserId: doc.userId });
      await startProcedure({ surgeryId: s.id, facilityId: PUNE, surgeonStaffId: doc.staffId, byUserId: doc.userId });
      await completeProcedure({ surgeryId: s.id, facilityId: PUNE, byUserId: doc.userId });
      return out({ surgeryId: s.id, icuBed: icuBed.label, theatre: ot.name });
    }
    case "coverage": {
      const c = await prisma.$transaction((t) => addPatientCoverage(t, { patientId: arg, payerId: INSURER, memberId: `E2E-${run}`, validFrom: new Date(Date.now() - 86_400_000), addedByUserId: doc.userId }));
      return out({ coverageId: c.id });
    }
    case "invoice": {
      const enc = await prisma.encounter.findUniqueOrThrow({ where: { id: arg } });
      // The worker posts the bed-day and theatre charges after their events; wait until none is pending.
      for (let i = 0; ; i++) {
        try {
          const inv = await prisma.$transaction(async (t) => {
            const draft = await draftInvoiceForAccount(t, { encounterId: enc.id, patientId: enc.patientId, facilityId: PUNE, generatedByUserId: doc.userId });
            for (const c of await t.charge.findMany({ where: { encounterId: enc.id, status: "POSTED", invoiceLine: null }, select: { id: true } })) await addChargeToInvoice(t, draft.id, c.id);
            return issueInvoice(t, draft.id, { byUserId: doc.userId });
          });
          return out({ invoiceId: inv.id, invoiceNumber: inv.invoiceNumber });
        } catch (err) {
          if (i > 30) throw err;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
    case "med-round": {
      const name = `Ward Smoke ${run}`;
      const patient = await registerPatient({ facilityId: PUNE, byUserId: doc.userId, fullName: name, sex: "M", ageYears: 71 });
      const A = await admissionFor(patient.id, PUNE, doc.staffId);
      const pharmacist = await staffOf(f.pharmacist.email);
      const pharmacy = await prisma.stockLocation.findFirstOrThrow({ where: { facilityId: PUNE, name: "Central Pharmacy" } });
      const drugName = `SmokeDrug${run}`;
      const item = await prisma.item.create({ data: { facilityId: PUNE, sku: `E2E-${run}`, name: drugName, category: "MEDICATION", baseUnit: "TABLET", reorderPoint: 0, reorderQuantity: 10 } });
      await prisma.$transaction((t) => linkMedicationToItem(t, SYSTEM_ACTOR, { target: { scope: "FACILITY", facilityId: PUNE }, drugName, itemId: item.id }));
      const lot = await prisma.itemLot.create({ data: { itemId: item.id, facilityId: PUNE, lotNumber: `E2E-LOT-${run}`, status: "ACTIVE", expiresAt: new Date("2030-01-01") } });
      await prisma.$transaction((t) => createAdjustment(t, { facilityId: PUNE, itemId: item.id, lotId: lot.id, locationId: pharmacy.id, quantityDelta: 10, reason: "FOUND", requestedByStaffId: pharmacist.staffId, actorUserId: pharmacist.userId, idempotencyKey: `e2e-${run}` }));
      const o = await createMedicationOrder({ facilityId: PUNE, encounterId: A.encounterId, patientId: patient.id, orderingStaffId: doc.staffId, drugName, dose: "1 tab", route: "PO", frequency: "OD", overrideReason: "smoke", byUserId: doc.userId });
      if (o.blocked) throw new Error("unexpected safety block");
      await verifyMedicationOrder(o.order.id, pharmacist.staffId, pharmacist.userId);
      await dispenseMedication({ medicationOrderId: o.order.id, pharmacistStaffId: pharmacist.staffId, quantity: 2, quantityUnit: "TABLET", dispensingLocationId: pharmacy.id, byUserId: pharmacist.userId });
      // This round: one dose due ten minutes ago, and one five hours ago that nobody recorded.
      await generateAdministrationSchedule(o.order.id, "STAT", 1, { from: new Date(Date.now() - 10 * 60_000) });
      await generateAdministrationSchedule(o.order.id, "STAT", 1, { from: new Date(Date.now() - 5 * 3_600_000) });
      // The runner's MAR sweep (as the worker runs it each tick): the unrecorded dose is now missed.
      await sweepMedicationSchedule();
      return out({ name, patientId: patient.id, orderId: o.order.id, drugName });
    }
    case "mar": {
      const rows = await prisma.medicationAdministration.findMany({ where: { medicationOrderId: arg }, orderBy: { scheduledAt: "asc" }, select: { status: true, scheduledAt: true, administeredByStaffId: true } });
      return out({ doses: rows.map((r) => ({ status: r.status, scheduledAt: r.scheduledAt.toISOString(), recorded: !!r.administeredByStaffId })) });
    }
    case "ward-device": {
      const nurse = await staffOf(f.nurse.email);
      const admin = { userId: doc.userId, facilityId: PUNE };
      const name = `Offline Smoke ${run}`;
      const patient = await registerPatient({ facilityId: PUNE, byUserId: doc.userId, fullName: name, sex: "F", ageYears: 64 });
      const ward = await prisma.ward.create({ data: { facilityId: PUNE, name: `E2E offline ward ${run}`, wardType: "GENERAL" } });
      const bed = await prisma.bed.create({ data: { facilityId: PUNE, wardId: ward.id, label: `E2E-OFF-${run}`, status: "OCCUPIED" } });
      const enc = await prisma.encounter.create({ data: { patientId: patient.id, facilityId: PUNE, type: "IPD", status: "ADMITTED", chiefComplaint: "offline smoke" } });
      await prisma.nursingAssignment.create({ data: { facilityId: PUNE, nurseStaffId: nurse.staffId, patientId: patient.id, encounterId: enc.id, bedId: bed.id, assignedByStaffId: doc.staffId } });
      await designateChargeNurse(admin, ward.id, { staffId: nurse.staffId });
      await enableOfflineForGate(admin, ward.id);
      const drugName = `OfflineDrug${run}`;
      const order = await prisma.medicationOrder.create({ data: { encounterId: enc.id, patientId: patient.id, drugName, dose: "1 tab", route: "PO", frequency: "TDS", orderedByStaffId: doc.staffId, status: "ACTIVE" } });
      const morphine = await prisma.medicationOrder.create({ data: { encounterId: enc.id, patientId: patient.id, drugName: "Morphine", dose: "5 mg", route: "PO", frequency: "QDS", orderedByStaffId: doc.staffId, status: "ACTIVE", isControlled: true } });
      const due = (orderId: string, min: number) => prisma.medicationAdministration.create({ data: { medicationOrderId: orderId, scheduledAt: new Date(Date.now() + min * 60_000), status: "DUE" } });
      const d1 = await due(order.id, 10);
      const d2 = await due(order.id, 25);
      const dc = await due(morphine.id, 15);
      const task = await prisma.task.create({ data: { facilityId: PUNE, title: `Reposition ${run}`, type: "GENERAL", source: "MANUAL", patientId: patient.id, encounterId: enc.id } });
      const device = await registerWardDevice(admin, { wardId: ward.id, label: `E2E tablet ${run}` });
      return out({ name, patientId: patient.id, encounterId: enc.id, deviceId: device.id, drugName, d1: d1.id, d2: d2.id, dc: dc.id, taskId: task.id, taskTitle: task.title });
    }
    case "take-over-give": {
      const nurse = await staffOf(f.nurse.email);
      const N = { userId: nurse.userId, staffId: nurse.staffId, facilityId: PUNE };
      await overrideLease(N, { administrationId: arg, reason: "The tablet is out of range; given at the bedside" });
      await administerMedication({ administrationId: arg, status: "GIVEN", administeredByStaffId: nurse.staffId, byUserId: nurse.userId });
      return out({ given: arg });
    }
    case "ward-state": {
      const a = JSON.parse(arg) as { patientId: string; encounterId: string; d1: string; d2: string; taskId: string };
      const d1 = await prisma.medicationAdministration.findUniqueOrThrow({ where: { id: a.d1 }, select: { status: true, administeredAt: true } });
      const d2Given = await prisma.medicationAdministration.count({ where: { status: "GIVEN", OR: [{ id: a.d2 }, { offlineGivenForAdministrationId: a.d2 }] } });
      const vitals = await prisma.vital.findMany({ where: { encounterId: a.encounterId }, select: { hr: true, recordedAt: true } });
      const task = await prisma.task.findUniqueOrThrow({ where: { id: a.taskId }, select: { status: true } });
      const conflicts = await prisma.offlineConflict.findMany({ where: { patientId: a.patientId }, select: { kind: true, severity: true, status: true } });
      return out({ d1: { status: d1.status, administeredAt: d1.administeredAt?.toISOString() ?? null }, d2Given, vitals: vitals.map((v) => v.hr), task: task.status, conflicts });
    }
    case "scan-counter": {
      const code = `E2E-${run.toUpperCase().slice(-8)}`;
      await createCounter({ userId: doc.userId, facilityId: PUNE }, { code, label: `E2E counter ${run}` });
      const qr = (await countersWithQr(PUNE, "http://e2e.local")).find((c) => c.code === code)!;
      const u = new URL(qr.url);
      return out({ path: `${u.pathname}${u.search}`, label: `E2E counter ${run}` });
    }
    default:
      throw new Error(`unknown step ${cmd}`);
  }
}

main().then(() => prisma.$disconnect()).catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
