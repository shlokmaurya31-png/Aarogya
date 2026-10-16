/**
 * Workflow spine §7: the core-journey replay test. Grows a step at a time
 * (§9); this version covers steps 1–8a of the §7 journey, the medication
 * round that step 6 wired, and step 9 (OT, with the charge-capture and
 * stock-movement consumers, spine step 8). Later steps (8b documents, 10–13
 * discharge, billing, claim) extend it.
 *
 * Drives the real service functions, drains the runner after each step and
 * asserts, by correlationId = the encounter:
 *   - each step's events (producer and consumer output, compared as a set per
 *     step), and the producers' events in emission order across the journey;
 *   - every payload passes its contract and the sensitive-data guard;
 *   - every delivery PROCESSED, zero dead letters;
 *   - the critical-result task opened at step 8 is completed by step 8a, and
 *     minutesToAcknowledge matches the stored timestamps;
 *   - replay: every event of the journey is replayed (replay.ts) and the runner
 *     run again → no new task, notification, dose or charge;
 *   - tenancy: a parallel journey in another facility writes only its own rows.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-core-journey.ts
 */
import { prisma } from "../src/lib/db";
import { registerPatient } from "../src/lib/patient/registration";
import { registerEdArrival } from "../src/lib/hospital/emergency";
import { recordTriage } from "../src/lib/hospital/triage";
import { createAdmissionRequest, allocateBed, confirmAdmissionRequest } from "../src/lib/hospital/admissionRequest";
import { transferWithinIcu } from "../src/lib/hospital/icu";
import { placeLabOrder } from "../src/lib/hospital/labOrder";
import { collectSpecimen, receiveSpecimen, acceptSpecimen } from "../src/lib/hospital/specimenLifecycle";
import { enterResult, verifyResult, acknowledgeResult } from "../src/lib/hospital/labResultLifecycle";
import { createMedicationOrder, verifyMedicationOrder, dispenseMedication, administerMedication } from "../src/lib/hospital/medicationLifecycle";
import { linkMedicationToItem, SYSTEM_ACTOR } from "../src/lib/hospital/inventory/itemMedicationLink";
import { createAdjustment } from "../src/lib/hospital/inventory/adjustment";
import { createProcedure, createOperatingTheatre, requestSurgery, transitionSurgery, scheduleSurgery, startProcedure, recordItemUsage, completeProcedure } from "../src/lib/hospital/surgery";
import { getEventContract } from "../src/lib/events/catalogue";
import { assertNoSensitiveData } from "../src/lib/events/sensitiveGuard";
import { replayEvent } from "../src/lib/events/replay";
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
const sorted = (xs: string[]) => [...xs].sort().join(",");
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
const tx = <T>(fn: (t: Tx) => Promise<T>) => prisma.$transaction(fn);

/** One journey through the services in a facility; returns the encounter and what it created. */
async function journey(facilityId: string, label: string, opts: { full: boolean }) {
  const run = `${label}-${Date.now().toString(36)}`;
  const staffOf = (role: "DOCTOR" | "NURSE" | "PHARMACIST") =>
    prisma.hospitalStaffProfile.findFirst({ where: { AND: [staffAtFacilityWhere(facilityId), { user: { role } }] }, orderBy: { id: "asc" } });
  const doctor = (await staffOf("DOCTOR"))!;
  const nurse = (await staffOf("NURSE")) ?? doctor;
  const by = doctor.userId;
  const steps: { name: string; expected: string[]; got: string[] }[] = [];
  let mark = BigInt(0);
  let encounterId = "";
  /** Run a step, drain the runner, and record the encounter's new events. */
  const step = async (name: string, expected: string[], fn: () => Promise<unknown>) => {
    await fn();
    await drain();
    const evs = await prisma.domainEventOutbox.findMany({ where: { correlationId: encounterId, seq: { gt: mark } }, orderBy: { seq: "asc" }, select: { seq: true, eventType: true } });
    if (evs.length) mark = evs[evs.length - 1].seq;
    steps.push({ name, expected, got: evs.map((e) => e.eventType) });
  };

  const patient = await registerPatient({ facilityId, byUserId: by, fullName: `Core Journey ${run}`, sex: "M", ageYears: 64 });
  const registered = await prisma.domainEventOutbox.count({ where: { eventType: "PatientRegistered", aggregateId: patient.id } });
  const ward = await prisma.ward.create({ data: { facilityId, name: `CJ ward ${run}`, wardType: "GENERAL" } });
  const icu = await prisma.ward.create({ data: { facilityId, name: `CJ ICU ${run}`, wardType: "ICU" } });
  const wardBed = await prisma.bed.create({ data: { facilityId, wardId: ward.id, label: `CJW-${run}` } });
  const icuBed = await prisma.bed.create({ data: { facilityId, wardId: icu.id, label: `CJI-${run}`, icuCapable: true } });

  // 2. ED arrival (sets the correlation for everything after).
  const enc = await registerEdArrival({ facilityId, patientId: patient.id, chiefComplaint: "Chest pain", arrivalMode: "AMBULANCE", registeredByStaffId: doctor.id, byUserId: by });
  encounterId = enc.id;
  await drain();
  const arrival = await prisma.domainEventOutbox.findMany({ where: { correlationId: enc.id }, orderBy: { seq: "asc" }, select: { seq: true, eventType: true } });
  mark = arrival.at(-1)?.seq ?? BigInt(0);
  steps.push({ name: "2 ED arrival", expected: ["EdArrivalRegistered"], got: arrival.map((e) => e.eventType) });

  await step("3 Triage", ["PatientTriaged"], () => recordTriage({ encounterId: enc.id, recordedByStaffId: doctor.id, acuity: 2, byUserId: by }));
  let reqId = "";
  await step("4 Admission request", ["AdmissionRequested", "TaskCreated"], async () => {
    reqId = (await createAdmissionRequest({ facilityId, patientId: patient.id, encounterId: enc.id, requestedByStaffId: doctor.id, reason: "ACS", priority: "URGENT", byUserId: by })).id;
  });
  await step("5 Bed", ["BedReserved", "TaskCompleted"], () => allocateBed(reqId, wardBed.id, doctor.id, by));
  let admissionId = "";
  // The seeded admission-checklist workflow (D7, prisma/seed.ts) adds its task.
  await step("6 Admit", ["AdmissionCreated", "TaskCreated"], async () => { admissionId = (await confirmAdmissionRequest(reqId, by)).admission.id; });
  await step("7 ICU", ["IcuAdmitted", "PatientTransferred"], () => transferWithinIcu({ admissionId, toBedId: icuBed.id, facilityId, reason: "deterioration", byUserId: by }));

  let resultId = "";
  // 8. Labs: the order (with its in-transaction collection task), collection,
  // and a critical result (→ critical-result task; notification, not an event).
  // Receipt in the lab is SpecimenStatusChanged (batch 4: found by the extended emit rule).
  await step("8 Labs", ["LabOrderPlaced", "TaskCreated", "SpecimenCollected", "SpecimenStatusChanged", "LabResultReleased", "TaskCreated"], async () => {
    const lab = await placeLabOrder({ facilityId, staffId: doctor.id, byUserId: by, encounterId: enc.id, patientId: patient.id, testName: `Troponin ${run}`, category: "Biochemistry", priority: "STAT" });
    const sp = lab.specimen!;
    await tx((t) => collectSpecimen(t, sp.id, nurse.id, undefined, nurse.userId));
    await tx((t) => receiveSpecimen(t, sp.id, nurse.id));
    await tx((t) => acceptSpecimen(t, sp.id, nurse.id));
    const r = await tx((t) => enterResult(t, { labOrderId: lab.order.id, specimenId: sp.id, value: "2.1", isCritical: true }));
    await tx((t) => verifyResult(t, r.id, doctor.id, by));
    resultId = r.id;
  });
  const critTask = () => prisma.task.findUnique({ where: { facilityId_idempotencyKey: { facilityId, idempotencyKey: `CRITICAL_RESULT_FOLLOW_UP:${resultId}` } } });
  const openAfter8 = (await critTask())?.status;
  await step("8a Critical acknowledgement", ["CriticalResultAcknowledged", "TaskCompleted"], () => tx((t) => acknowledgeResult(t, resultId, doctor.id, by)));

  let orderId = "";
  if (opts.full) {
    // 8c. A medication round: order, verify (→ mar-scheduler doses), dispense, administer.
    const pharmacist = (await staffOf("PHARMACIST"))!;
    const pharmacy = await prisma.stockLocation.findFirstOrThrow({ where: { facilityId, name: "Central Pharmacy" } });
    const drugName = `CoreJourneyDrug${run}`;
    const item = await prisma.item.create({ data: { facilityId, sku: `CJ-${run}`, name: drugName, category: "MEDICATION", baseUnit: "TABLET" } });
    await tx((t) => linkMedicationToItem(t, SYSTEM_ACTOR, { target: { scope: "FACILITY", facilityId }, drugName, itemId: item.id }));
    const lot = await prisma.itemLot.create({ data: { itemId: item.id, facilityId, lotNumber: `CJ-LOT-${run}`, status: "ACTIVE", expiresAt: new Date("2029-01-01") } });
    await tx((t) => createAdjustment(t, { facilityId, itemId: item.id, lotId: lot.id, locationId: pharmacy.id, quantityDelta: 10, reason: "FOUND", requestedByStaffId: pharmacist.id, actorUserId: pharmacist.userId, idempotencyKey: `cj-${run}` }));
    await step("8c Medication", ["MedicationOrdered", "MedicationVerified", "MedicationDispensed", "MedicationAdministered"], async () => {
      const o = await createMedicationOrder({ facilityId, encounterId: enc.id, patientId: patient.id, orderingStaffId: doctor.id, drugName, dose: "1 tab", route: "PO", frequency: "BD", overrideReason: "journey", byUserId: by });
      if (o.blocked) throw new Error("unexpected safety block");
      orderId = o.order.id;
      await verifyMedicationOrder(orderId, pharmacist.id, pharmacist.userId);
      await drain(); // mar-scheduler writes the doses
      await dispenseMedication({ medicationOrderId: orderId, pharmacistStaffId: pharmacist.id, quantity: 2, quantityUnit: "TABLET", dispensingLocationId: pharmacy.id, byUserId: pharmacist.userId });
      const first = await prisma.medicationAdministration.findFirstOrThrow({ where: { medicationOrderId: orderId, status: "DUE" }, orderBy: { scheduledAt: "asc" } });
      await administerMedication({ administrationId: first.id, status: "GIVEN", administeredByStaffId: nurse.id, safetyChecksConfirmed: true, byUserId: nurse.userId });
    });
  }
  let surgeryId = "";
  let usageId = "";
  if (opts.full) {
    // 9. OT: the case, a consumable from stock, completion (→ charge-capture, stock-movement).
    const pharmacy = await prisma.stockLocation.findFirstOrThrow({ where: { facilityId, name: "Central Pharmacy" } });
    const proc = await createProcedure({ facilityId, code: `CJ-PROC-${run}`, name: "Angioplasty", byUserId: by });
    const ot = await createOperatingTheatre({ facilityId, name: `CJ OT ${run}`, byUserId: by });
    const kit = await prisma.item.create({ data: { facilityId, sku: `CJ-KIT-${run}`, name: `Kit ${run}`, category: "CONSUMABLE", baseUnit: "PIECE" } });
    const kitLot = await prisma.itemLot.create({ data: { itemId: kit.id, facilityId, lotNumber: `CJ-KIT-LOT-${run}`, status: "ACTIVE", expiresAt: new Date("2030-01-01") } });
    await tx((t) => createAdjustment(t, { facilityId, itemId: kit.id, lotId: kitLot.id, locationId: pharmacy.id, quantityDelta: 1, reason: "FOUND", requestedByStaffId: doctor.id, actorUserId: by, idempotencyKey: `cj-kit-${run}` }));
    await step("9 OT", ["SurgeryRequested", "SurgeryStatusChanged", "SurgeryStatusChanged", "SurgeryScheduled", "ProcedureStarted", "SurgeryItemUsed", "ProcedureCompleted"], async () => {
      const s = await requestSurgery({ facilityId, patientId: patient.id, encounterId: enc.id, procedureId: proc.id, urgency: "URGENT", requestedByStaffId: doctor.id, byUserId: by });
      surgeryId = s.id;
      await transitionSurgery({ surgeryId, facilityId, to: "REVIEWED", actorStaffId: doctor.id, byUserId: by });
      await transitionSurgery({ surgeryId, facilityId, to: "APPROVED", actorStaffId: doctor.id, byUserId: by });
      const at = new Date(Date.now() + 2 * 86_400_000 + Math.floor(Math.random() * 1000) * 60_000);
      await scheduleSurgery({ surgeryId, facilityId, operatingTheatreId: ot.id, startAt: at, endAt: new Date(at.getTime() + 3_600_000), schedulerStaffId: doctor.id, byUserId: by });
      await startProcedure({ surgeryId, facilityId, surgeonStaffId: doctor.id, byUserId: by });
      usageId = (await recordItemUsage({ surgeryId, facilityId, usageType: "CONSUMABLE", itemId: kit.id, itemLotId: kitLot.id, quantity: 1, locationId: pharmacy.id, recordedByStaffId: doctor.id, actorUserId: by, byUserId: by })).id;
      await completeProcedure({ surgeryId, facilityId, byUserId: by });
    });
  }
  return { facilityId, patientId: patient.id, encounterId: enc.id, orderId, resultId, surgeryId, usageId, steps, registered, openAfter8, critTask };
}

async function main() {
  const a = await journey("fac-amc-pune", "A", { full: true });
  const b = await journey("fac-amc-noida", "B", { full: false });

  report("1 Register: PatientRegistered once", a.registered === 1);
  for (const s of a.steps) report(`${s.name}: ${sorted(s.expected)}`, sorted(s.got) === sorted(s.expected), s.got.join(" → "));

  const all = await prisma.domainEventOutbox.findMany({ where: { correlationId: a.encounterId }, orderBy: { seq: "asc" } });
  const producers = all.map((e) => e.eventType).filter((t) => !t.startsWith("Task"));
  // IcuAdmitted is emitted before PatientTransferred inside the transfer (as the ADT gate asserts).
  const expectedProducers = ["EdArrivalRegistered", "PatientTriaged", "AdmissionRequested", "BedReserved", "AdmissionCreated", "IcuAdmitted", "PatientTransferred",
    "LabOrderPlaced", "SpecimenCollected", "SpecimenStatusChanged", "LabResultReleased", "CriticalResultAcknowledged", "MedicationOrdered", "MedicationVerified", "MedicationDispensed", "MedicationAdministered",
    "SurgeryRequested", "SurgeryStatusChanged", "SurgeryStatusChanged", "SurgeryScheduled", "ProcedureStarted", "SurgeryItemUsed", "ProcedureCompleted"];
  report("The producers' events, in emission order", producers.join() === expectedProducers.join(), producers.join(" → "));

  const bad = all.flatMap((e) => {
    const c = getEventContract(e.eventType, e.eventVersion);
    if (!c) return [`${e.eventType}: no contract`];
    if (!c.payload.safeParse(e.payload).success) return [`${e.eventType}: payload fails its contract`];
    try { assertNoSensitiveData(e.payload as Record<string, unknown>); } catch { return [`${e.eventType}: sensitive data`]; }
    return [];
  });
  report(`Every payload (${all.length}) passes its contract and the sensitive-data guard`, bad.length === 0, bad.join("; "));

  const ids = all.map((e) => e.eventId);
  const notProcessed = await prisma.domainEventDelivery.count({ where: { eventId: { in: ids }, status: { not: "PROCESSED" } } });
  const dead = await prisma.domainEventOutbox.count({ where: { eventId: { in: ids }, status: "DEAD_LETTER" } });
  report("Every delivery PROCESSED; zero dead letters", notProcessed === 0 && dead === 0, `${notProcessed} unprocessed, ${dead} dead`);

  const crit = await a.critTask();
  const ack = all.find((e) => e.eventType === "CriticalResultAcknowledged")!;
  const result = await prisma.labResult.findUniqueOrThrow({ where: { id: a.resultId } });
  report("The critical-result task opened at 8 is completed by 8a", a.openAfter8 === "OPEN" && crit?.status === "COMPLETED");
  report("minutesToAcknowledge matches the stored timestamps",
    (ack.payload as { minutesToAcknowledge: number }).minutesToAcknowledge === Math.floor((result.acknowledgedAt!.getTime() - result.verifiedAt!.getTime()) / 60_000));
  const doses = await prisma.medicationAdministration.count({ where: { medicationOrderId: a.orderId } });
  report("mar-scheduler scheduled the BD doses once", doses === 3, String(doses));
  const otCharges = await prisma.charge.count({ where: { OR: [{ sourceType: "Surgery", sourceId: a.surgeryId }, { sourceType: "SurgeryItemUsage", sourceId: a.usageId }, { sourceType: "IcuAdmission" }], encounterId: a.encounterId } });
  const kitIssued = await prisma.stockLedgerEntry.count({ where: { sourceType: "SurgeryItemUsage", sourceId: a.usageId } });
  report("9 OT: charge-capture charged the procedure, the consumable and the ICU admission once each; stock-movement issued the kit once", otCharges === 3 && kitIssued === 1, `${otCharges} charges, ${kitIssued} ledger`);

  // Replay every event of journey A through replay.ts; nothing new may appear.
  const counts = async () => [
    await prisma.task.count({ where: { encounterId: a.encounterId } }),
    await prisma.notification.count({ where: { encounterId: a.encounterId } }),
    await prisma.medicationAdministration.count({ where: { medicationOrder: { encounterId: a.encounterId } } }),
    await prisma.charge.count({ where: { encounterId: a.encounterId } }),
    await prisma.stockLedgerEntry.count({ where: { encounterId: a.encounterId } }),
  ].join("/");
  const before = await counts();
  const admin = await prisma.user.findFirstOrThrow({ where: { role: "AAROGYA_ADMIN" }, orderBy: { id: "asc" } });
  const platform = await loadActorMemberships(admin.id, "AAROGYA_ADMIN");
  for (const id of ids) await replayEvent(platform, id, { reason: "core-journey replay gate" });
  await drain();
  const after = await counts();
  report("Replay: re-running every event creates no task, notification, dose, charge or stock movement (tasks/notifications/doses/charges/ledger)", after === before, `${before} → ${after}`);
  const replayDead = await prisma.domainEventOutbox.count({ where: { eventId: { in: ids }, status: { not: "PROCESSED" } } });
  report("…and every replayed event is PROCESSED again", replayDead === 0, String(replayDead));

  // Tenancy: each journey's rows stay in its own facility.
  const leak = await Promise.all([
    prisma.task.count({ where: { encounterId: a.encounterId, facilityId: { not: a.facilityId } } }),
    prisma.task.count({ where: { encounterId: b.encounterId, facilityId: { not: b.facilityId } } }),
    prisma.notification.count({ where: { encounterId: a.encounterId, facilityId: { not: a.facilityId } } }),
    prisma.notification.count({ where: { encounterId: b.encounterId, facilityId: { not: b.facilityId } } }),
    prisma.domainEventOutbox.count({ where: { correlationId: b.encounterId, facilityId: { not: b.facilityId } } }),
  ]);
  report("Tenancy: the parallel journey in another facility writes only its own rows", leak.every((n) => n === 0), leak.join(","));
  report("…and it ran the same chain there (steps 2–8a)", b.steps.every((s) => sorted(s.got) === sorted(s.expected)), b.steps.map((s) => `${s.name}:${s.got.length}`).join(" "));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
