/**
 * Workflow spine §9 step 4: ADT events and the task-generator consumer.
 *
 *   1. A full ADT journey through the services emits each event exactly once,
 *      correlated by the encounter: EdArrivalRegistered, PatientTriaged (not
 *      for a draft), AdmissionRequested, BedReserved, AdmissionCreated,
 *      PatientTransferred, IcuAdmitted (entering ICU only), DischargeInitiated,
 *      PatientDischarged, EncounterClosed.
 *   2. Encounters and appointments: EncounterOpened, PatientCheckedIn (with the
 *      encounter it opens), AppointmentCancelled, EncounterClosed from
 *      transitionEncounter.
 *   3. ED disposition: EdDispositionDecided, plus EncounterClosed for a patient
 *      who left, and AdmissionCreated + IcuAdmitted for an inline ICU admission.
 *   4. task-generator: a bed-allocation task opens on AdmissionRequested and
 *      closes on BedReserved; discharge prep opens and closes; ED dispositions
 *      create their follow-up/handover tasks. Redelivering every event creates
 *      nothing new.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-adt-events.ts
 */
import { prisma } from "../src/lib/db";
import { registerPatient } from "../src/lib/patient/registration";
import { registerEdArrival, dispositionEncounter } from "../src/lib/hospital/emergency";
import { recordTriage } from "../src/lib/hospital/triage";
import { createAdmissionRequest, allocateBed, confirmAdmissionRequest } from "../src/lib/hospital/admissionRequest";
import { transferPatient, initiateDischarge, updateDischargeReadiness, finalizeDischarge } from "../src/lib/hospital/admission";
import { transferWithinIcu } from "../src/lib/hospital/icu";
import { openEncounter } from "../src/lib/hospital/encounter";
import { checkInAppointment, cancelAppointment } from "../src/lib/hospital/appointment";
import { transitionEncounter } from "../src/lib/hospital/encounterStateMachine";
import { runTick } from "../src/lib/runner/tick";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const doctor = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(facilityId), { user: { role: "DOCTOR" } }] }, orderBy: { id: "asc" } });
  const by = doctor.userId;
  const ward = await prisma.ward.create({ data: { facilityId, name: `ADT ward ${run}`, wardType: "GENERAL" } });
  const icu = await prisma.ward.create({ data: { facilityId, name: `ADT ICU ${run}`, wardType: "ICU" } });
  const bed = (w: { id: string }, label: string, icuCapable = false) => prisma.bed.create({ data: { facilityId, wardId: w.id, label: `${label}-${run}`, icuCapable } });
  const [wardBed1, wardBed2, icuBed1, icuBed2] = [await bed(ward, "W1"), await bed(ward, "W2"), await bed(icu, "I1", true), await bed(icu, "I2", true)];
  const events = (correlationId: string) => prisma.domainEventOutbox.findMany({ where: { correlationId }, orderBy: { seq: "asc" }, select: { eventType: true, payload: true, eventId: true } });
  const types = async (corr: string) => (await events(corr)).map((e) => e.eventType);
  const count = (list: string[], t: string) => list.filter((x) => x === t).length;

  // 1. ADT journey.
  const patient = await registerPatient({ facilityId, byUserId: by, fullName: `ADT Journey ${run}`, sex: "M", ageYears: 61 });
  const enc = await registerEdArrival({ facilityId, patientId: patient.id, chiefComplaint: "Chest pain", arrivalMode: "AMBULANCE", registeredByStaffId: doctor.id, byUserId: by });
  await recordTriage({ encounterId: enc.id, recordedByStaffId: doctor.id, acuity: 2, byUserId: by, status: "DRAFT" });
  const afterDraft = await types(enc.id);
  report("A draft triage emits nothing", count(afterDraft, "PatientTriaged") === 0, afterDraft.join(","));
  await recordTriage({ encounterId: enc.id, recordedByStaffId: doctor.id, acuity: 2, byUserId: by });
  const req = await createAdmissionRequest({ facilityId, patientId: patient.id, encounterId: enc.id, requestedByStaffId: doctor.id, reason: "ACS", priority: "URGENT", byUserId: by });
  await runTick({ budgetMs: 20_000 });
  const bedTask = () => prisma.task.findUnique({ where: { facilityId_idempotencyKey: { facilityId, idempotencyKey: `BED_ALLOCATION:${req.id}` } } });
  const openBedTask = await bedTask();
  report("task-generator: AdmissionRequested opens a bed-allocation task (URGENT)", openBedTask?.status === "OPEN" && openBedTask.priority === "URGENT" && openBedTask.createdByStaffId === null && openBedTask.encounterId === enc.id);
  await allocateBed(req.id, wardBed1.id, doctor.id, by);
  await runTick({ budgetMs: 20_000 });
  report("…and BedReserved closes it", (await bedTask())?.status === "COMPLETED");
  const { admission } = await confirmAdmissionRequest(req.id, by);
  await transferWithinIcu({ admissionId: admission.id, toBedId: icuBed1.id, facilityId, reason: "deterioration", byUserId: by });
  await transferWithinIcu({ admissionId: admission.id, toBedId: icuBed2.id, facilityId, reason: "isolation", byUserId: by });
  await transferPatient({ admissionId: admission.id, toBedId: wardBed2.id, reason: "step-down", byUserId: by });
  const discharge = await initiateDischarge(admission.id, by, doctor.id);
  await runTick({ budgetMs: 20_000 });
  const prepTask = () => prisma.task.findUnique({ where: { facilityId_idempotencyKey: { facilityId, idempotencyKey: `DISCHARGE_PREP:${discharge.id}` } } });
  report("task-generator: DischargeInitiated opens a discharge-prep task", (await prepTask())?.status === "OPEN");
  await updateDischargeReadiness(discharge.id, { clinicallyReady: true, documentationReady: true, billingReady: true, insuranceReady: true, pharmacyReady: true, transportReady: true });
  await finalizeDischarge(discharge.id, by, { summary: "gate" });
  await runTick({ budgetMs: 20_000 });
  report("…and PatientDischarged closes it", (await prepTask())?.status === "COMPLETED");

  const journey = await types(enc.id);
  const expected = ["EdArrivalRegistered", "PatientTriaged", "AdmissionRequested", "BedReserved", "AdmissionCreated",
    "IcuAdmitted", "PatientTransferred", "PatientTransferred", "PatientTransferred", "DischargeInitiated", "PatientDischarged", "EncounterClosed"];
  report("The journey's events, in order, correlated by the encounter", journey.join() === expected.join(), journey.join(" → "));
  const icuEvents = (await events(enc.id)).filter((e) => e.eventType === "IcuAdmitted");
  report("IcuAdmitted only on entering ICU (not ICU→ICU, not ICU→ward), marked viaTransfer",
    icuEvents.length === 1 && (icuEvents[0].payload as { viaTransfer: boolean }).viaTransfer === true);
  const triaged = (await events(enc.id)).find((e) => e.eventType === "PatientTriaged");
  const tp = (triaged?.payload ?? {}) as Record<string, unknown>;
  report("PatientTriaged carries the acuity and IDs only", Object.keys(tp).sort().join() === "acuity,encounterId,patientId,triageId" && tp.acuity === 2 && tp.encounterId === enc.id && tp.patientId === patient.id);
  const closed = (await events(enc.id)).find((e) => e.eventType === "EncounterClosed");
  report("EncounterClosed records the terminal status", (closed?.payload as { toStatus: string }).toStatus === "DISCHARGED");

  // 2. Encounters and appointments.
  const opd = await openEncounter({ facilityId, patientId: patient.id, type: "OPD", chiefComplaint: "Review", byUserId: by });
  report("openEncounter emits EncounterOpened", (await types(opd.id)).join() === "EncounterOpened");
  await transitionEncounter(opd.id, "CANCELLED", { byUserId: by, reason: "gate" });
  report("transitionEncounter to a terminal status emits EncounterClosed", count(await types(opd.id), "EncounterClosed") === 1);
  const start = new Date(Date.now() + 3 * 86_400_000);
  const appt = (offsetMin: number) => prisma.appointment.create({
    data: { facilityId, doctorStaffId: doctor.id, patientId: patient.id, scheduledStart: new Date(start.getTime() + offsetMin * 60_000), scheduledEnd: new Date(start.getTime() + (offsetMin + 15) * 60_000), createdByStaffId: doctor.id, reason: "Follow-up" },
  });
  const a1 = await appt(0);
  const checkedIn = await checkInAppointment(a1.id, by);
  const ciTypes = await types(checkedIn.encounterId!);
  report("Check-in opens an encounter and emits EncounterOpened + PatientCheckedIn", ciTypes.join() === "EncounterOpened,PatientCheckedIn", ciTypes.join());
  const a2 = await appt(30);
  await cancelAppointment(a2.id, "patient request", `patient:${patient.userId ?? "x"}`, by);
  const cancelled = await prisma.domainEventOutbox.findFirst({ where: { eventType: "AppointmentCancelled", aggregateId: a2.id } });
  report("cancelAppointment emits AppointmentCancelled (byPatient from the canceller)", (cancelled?.payload as { byPatient?: boolean } | undefined)?.byPatient === true);

  // 3. ED dispositions.
  const left = await registerEdArrival({ facilityId, patientId: patient.id, chiefComplaint: "Headache", byUserId: by });
  const leftDisp = await dispositionEncounter({ encounterId: left.id, facilityId, type: "LWBS", dispositionedByStaffId: doctor.id, byUserId: by });
  const leftTypes = await types(left.id);
  report("LWBS: EdArrivalRegistered, EncounterClosed, EdDispositionDecided", leftTypes.join() === "EdArrivalRegistered,EncounterClosed,EdDispositionDecided", leftTypes.join());
  const icuBed3 = await bed(icu, "I3", true);
  const sick = await registerEdArrival({ facilityId, patientId: patient.id, chiefComplaint: "Sepsis", byUserId: by });
  const admitDisp = await dispositionEncounter({ encounterId: sick.id, facilityId, type: "ADMIT_ICU", bedId: icuBed3.id, dispositionedByStaffId: doctor.id, byUserId: by });
  const sickTypes = await types(sick.id);
  report("ED admission to ICU: AdmissionCreated + IcuAdmitted + EdDispositionDecided", sickTypes.join() === "EdArrivalRegistered,AdmissionCreated,IcuAdmitted,EdDispositionDecided", sickTypes.join());
  await runTick({ budgetMs: 20_000 });
  const followUp = await prisma.task.findUnique({ where: { facilityId_idempotencyKey: { facilityId, idempotencyKey: `ED_FOLLOW_UP:${leftDisp.id}` } } });
  const handover = await prisma.task.findUnique({ where: { facilityId_idempotencyKey: { facilityId, idempotencyKey: `WARD_HANDOVER:${admitDisp.id}` } } });
  report("task-generator: LWBS creates an ED follow-up task", followUp?.status === "OPEN");
  report("task-generator: ICU admission creates a STAT handover task", handover?.priority === "STAT");

  // 4. Redelivery creates nothing new.
  const ids = (await prisma.domainEventOutbox.findMany({ where: { correlationId: { in: [enc.id, left.id, sick.id] } }, select: { eventId: true } })).map((e) => e.eventId);
  const before = await prisma.task.count({ where: { encounterId: { in: [enc.id, left.id, sick.id] } } });
  await prisma.domainEventDelivery.updateMany({ where: { eventId: { in: ids } }, data: { status: "PENDING" } });
  await prisma.domainEventOutbox.updateMany({ where: { eventId: { in: ids } }, data: { status: "PENDING", processedAt: null } });
  await runTick({ budgetMs: 30_000 });
  const after = await prisma.task.count({ where: { encounterId: { in: [enc.id, left.id, sick.id] } } });
  report("Redelivering every event creates no new task", after === before, `${before} → ${after}`);
  report("…and closed tasks stay closed", (await bedTask())?.status === "COMPLETED" && (await prepTask())?.status === "COMPLETED");
  const dead = await prisma.domainEventOutbox.count({ where: { eventId: { in: ids }, status: "DEAD_LETTER" } });
  report("No journey event dead-lettered", dead === 0, String(dead));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
