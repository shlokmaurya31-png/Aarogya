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
 *      nothing new. Each task emits TaskCreated / TaskCompleted once (D6).
 *   5. Triage step 4: AdmissionRequestStatusChanged (defer, reject, release,
 *      cancel; a cancelled / rejected request cancels its bed-allocation task),
 *      AppointmentStatusChanged, PatientLocationChanged (never the area
 *      label), ObservationRecorded (ED reassessment, never the findings),
 *      ResuscitationStatusChanged (SENSITIVE), TransferRequestStatusChanged
 *      (the whole lifecycle), PatientMergeStatusChanged.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-adt-events.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerPatient } from "../src/lib/patient/registration";
import { registerEdArrival, dispositionEncounter } from "../src/lib/hospital/emergency";
import { recordTriage } from "../src/lib/hospital/triage";
import { createAdmissionRequest, allocateBed, confirmAdmissionRequest, deferRequest, rejectRequest, releaseReservation, cancelRequest } from "../src/lib/hospital/admissionRequest";
import { assignEdLocation, releaseEdLocation, recordReassessment, activateResuscitation, updateResuscitation } from "../src/lib/hospital/emergency";
import { confirmAppointment, markNoShow } from "../src/lib/hospital/appointment";
import { createTransferRequest, acceptTransferRequest, reserveBedForTransfer, markPatientInTransit, completeTransferRequest, cancelTransferRequest } from "../src/lib/hospital/transferRequest";
import { admitPatient } from "../src/lib/hospital/admission";
import { mergePatients, unmergePatients } from "../src/lib/patient/merge";
import { getEventContract } from "../src/lib/events/catalogue";
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

  const journey = (await types(enc.id)).filter((t) => !t.startsWith("Task")); // task events are checked below
  const expected = ["EdArrivalRegistered", "PatientTriaged", "AdmissionRequested", "BedReserved", "AdmissionCreated",
    "IcuAdmitted", "PatientTransferred", "PatientTransferred", "PatientTransferred", "DischargeInitiated",
    // ChargePosted (step 9): the ICU fee (charge-capture, at the first drain after the ICU move) and the bed-days (in finalize).
    "ChargePosted", "ChargePosted", "PatientDischarged", "EncounterClosed"];
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
  const taskEvents = async (taskId: string) => (await prisma.domainEventOutbox.findMany({ where: { aggregateType: "TASK", aggregateId: taskId }, select: { eventType: true } })).map((e) => e.eventType).sort().join();
  report("D6: the bed task emitted TaskCreated and TaskCompleted once each, redelivery included", await taskEvents((await bedTask())!.id) === "TaskCompleted,TaskCreated");
  report("…and so did the discharge-prep task", await taskEvents((await prepTask())!.id) === "TaskCompleted,TaskCreated");
  const dead = await prisma.domainEventOutbox.count({ where: { eventId: { in: ids }, status: "DEAD_LETTER" } });
  report("No journey event dead-lettered", dead === 0, String(dead));

  // 5. Triage step 4.
  const payloadsOf = async (aggregateId: string, type: string) =>
    (await prisma.domainEventOutbox.findMany({ where: { aggregateId, eventType: type }, orderBy: { seq: "asc" }, select: { payload: true } })).map((e) => e.payload as Record<string, unknown>);
  const moves = (ps: Record<string, unknown>[]) => ps.map((p) => `${p.from}>${p.to}`).join(",");
  const enc5 = await registerEdArrival({ facilityId, patientId: patient.id, chiefComplaint: "Step 4", byUserId: by });
  const r1 = await createAdmissionRequest({ facilityId, patientId: patient.id, encounterId: enc5.id, requestedByStaffId: doctor.id, reason: "obs", priority: "ROUTINE", byUserId: by });
  await deferRequest(r1.id, by);
  await rejectRequest(r1.id, "no beds", doctor.id, by);
  report("AdmissionRequestStatusChanged: defer then reject", moves(await payloadsOf(r1.id, "AdmissionRequestStatusChanged")) === "PENDING>DEFERRED,DEFERRED>REJECTED");
  const bed5 = await bed(ward, "W5");
  const r2 = await createAdmissionRequest({ facilityId, patientId: patient.id, encounterId: enc5.id, requestedByStaffId: doctor.id, reason: "obs", priority: "ROUTINE", byUserId: by });
  await allocateBed(r2.id, bed5.id, doctor.id, by);
  await releaseReservation(r2.id, by);
  await cancelRequest(r2.id, by);
  const r2moves = await payloadsOf(r2.id, "AdmissionRequestStatusChanged");
  report("…release (naming the released bed) then cancel", moves(r2moves) === "BED_RESERVED>PENDING,PENDING>CANCELLED" && r2moves[0].releasedBedId === bed5.id);
  await runTick({ budgetMs: 20_000 });
  const bedTaskOf = (id: string) => prisma.task.findUnique({ where: { facilityId_idempotencyKey: { facilityId, idempotencyKey: `BED_ALLOCATION:${id}` } } });
  report("task-generator: a rejected request's bed-allocation task is CANCELLED (it stayed open before)", (await bedTaskOf(r1.id))?.status === "CANCELLED");

  const a5 = await appt(60);
  await confirmAppointment(a5.id, by);
  const a6 = await appt(90);
  await markNoShow(a6.id, doctor.id, by);
  report("AppointmentStatusChanged: confirm, no-show",
    moves(await payloadsOf(a5.id, "AppointmentStatusChanged")) === "REQUESTED>CONFIRMED" && moves(await payloadsOf(a6.id, "AppointmentStatusChanged")) === "REQUESTED>NO_SHOW");

  const bay = await bed(ward, "B5");
  const loc1 = await assignEdLocation({ encounterId: enc5.id, facilityId, areaLabel: `Corridor ${run}`, assignedByStaffId: doctor.id, byUserId: by });
  const loc2 = await assignEdLocation({ encounterId: enc5.id, facilityId, bedId: bay.id, assignedByStaffId: doctor.id, byUserId: by });
  await releaseEdLocation({ encounterId: enc5.id, facilityId, byUserId: by });
  const locs = await payloadsOf(enc5.id, "PatientLocationChanged");
  report("PatientLocationChanged: assigned, moved (naming the released location), released",
    locs.map((l) => l.change).join() === "ASSIGNED,ASSIGNED,RELEASED" && locs[1].releasedLocationId === loc1.id && locs[1].bedId === bay.id && locs[2].locationId === loc2.id);
  report("…and never the free-text area label", !JSON.stringify(locs).includes("Corridor"));
  const ra = await recordReassessment({ encounterId: enc5.id, facilityId, reassessedByStaffId: doctor.id, findings: `pain worse ${run}`, byUserId: by });
  const obs = await payloadsOf(ra.id, "ObservationRecorded");
  report("ObservationRecorded: ED_REASSESSMENT, without the findings", obs.length === 1 && obs[0].observationKind === "ED_REASSESSMENT" && !JSON.stringify(obs).includes("pain"));
  const resus = await activateResuscitation({ encounterId: enc5.id, facilityId, activatedByStaffId: doctor.id, byUserId: by });
  await updateResuscitation({ resuscitationId: resus.id, facilityId, to: "STABILIZED", actorStaffId: doctor.id, byUserId: by });
  await updateResuscitation({ resuscitationId: resus.id, facilityId, to: "CLOSED", actorStaffId: doctor.id, byUserId: by });
  report("ResuscitationStatusChanged: null → ACTIVATED → STABILIZED → CLOSED", moves(await payloadsOf(resus.id, "ResuscitationStatusChanged")) === "null>ACTIVATED,ACTIVATED>STABILIZED,STABILIZED>CLOSED");

  const ipd = await openEncounter({ facilityId, patientId: patient.id, type: "IPD", chiefComplaint: "Transfer", byUserId: by });
  const [tb1, tb2] = [await bed(ward, "T1"), await bed(ward, "T2")];
  const adm5 = await admitPatient({ encounterId: ipd.id, bedId: tb1.id, admittingStaffId: doctor.id, reason: "transfer gate", byUserId: by });
  const tr = await createTransferRequest({ admissionId: adm5.id, facilityId, patientId: patient.id, requestedByStaffId: doctor.id, reason: "step-down", priority: "URGENT", byUserId: by });
  await acceptTransferRequest(tr.id, doctor.id, by);
  await reserveBedForTransfer(tr.id, tb2.id, by);
  await markPatientInTransit(tr.id, by);
  await completeTransferRequest(tr.id, by);
  const trEvents = await payloadsOf(tr.id, "TransferRequestStatusChanged");
  report("TransferRequestStatusChanged: the whole lifecycle, the completion naming its Transfer",
    moves(trEvents) === "null>REQUESTED,REQUESTED>ACCEPTED,ACCEPTED>BED_RESERVED,BED_RESERVED>PATIENT_IN_TRANSIT,PATIENT_IN_TRANSIT>COMPLETED"
      && typeof trEvents[4].transferId === "string" && trEvents[0].encounterId === ipd.id);
  const tr2 = await createTransferRequest({ admissionId: adm5.id, facilityId, patientId: patient.id, requestedByStaffId: doctor.id, reason: "again", byUserId: by });
  await cancelTransferRequest(tr2.id, by);
  report("…and a cancellation", moves(await payloadsOf(tr2.id, "TransferRequestStatusChanged")) === "null>REQUESTED,REQUESTED>CANCELLED");

  const dupe = await registerPatient({ facilityId, byUserId: by, fullName: `ADT Dupe ${run}`, sex: "M", ageYears: 61 });
  await mergePatients({ sourcePatientId: dupe.id, targetPatientId: patient.id, actorStaffId: doctor.id, actorUserId: by, reason: "duplicate" });
  await unmergePatients({ patientId: dupe.id, actorStaffId: doctor.id, actorUserId: by, reason: "not the same person" });
  report("PatientMergeStatusChanged: MERGED then UNMERGED, on the source patient",
    (await payloadsOf(dupe.id, "PatientMergeStatusChanged")).map((m) => `${m.action}:${m.targetPatientId === patient.id}`).join() === "MERGED:true,UNMERGED:true");
  const resusEvent = await prisma.domainEventOutbox.findFirst({ where: { eventType: "ResuscitationStatusChanged", aggregateId: resus.id } });
  await runTick({ budgetMs: 20_000 });
  report("Step-4 events all delivered; ResuscitationStatusChanged is SENSITIVE",
    (await prisma.domainEventOutbox.count({ where: { correlationId: { in: [enc5.id, ipd.id] }, status: { not: "PROCESSED" } } })) === 0
      && !!resusEvent && getEventContract("ResuscitationStatusChanged", resusEvent.eventVersion)?.sensitivity === "SENSITIVE");

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
