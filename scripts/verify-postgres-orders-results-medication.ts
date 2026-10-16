/**
 * Workflow spine §9 step 6: orders, results and medication events, the
 * mar-scheduler and notification-dispatch consumers, and the MAR sweep.
 *
 *   1. Lab: placeLabOrder → LabOrderPlaced (a 15 s resubmission emits nothing);
 *      SpecimenCollected; a rejection and recollection → SpecimenStatusChanged.
 *   2. Critical lab result: LabResultReleased (correlated by the encounter) →
 *      a STAT task (exactly one: the seeded critical-lab-review workflow only
 *      escalates it, at SLA breach, and never escalates a closed one) and one
 *      notification to the orderer; acknowledgement →
 *      CriticalResultAcknowledged (minutesToAcknowledge from the stored
 *      timestamps) → the task completes. An amendment → DiagnosticReportAmended
 *      on the original's aggregate.
 *   3. Imaging: ImagingOrderPlaced, study scheduled / rescheduled / completed;
 *      a critical report's acknowledgement is ordered on IMAGING_REPORT; a
 *      report with no study is still released (it used to emit nothing).
 *   4. Medication: no doses before verification; MedicationVerified →
 *      mar-scheduler writes 3 doses from the verification time, once
 *      (redelivery adds none); MedicationDispensed; MedicationAdministered;
 *      a nurse's MISSED → MedicationDoseMissed (NURSE).
 *   5. MAR sweep: a DUE dose past its grace → MISSED ("not-recorded") +
 *      MedicationDoseMissed (SWEEP) → a review task and notifications to the
 *      prescriber and the assigned nurse; a late recording is a new linked row
 *      (once) and the missed row stays. Discontinuing cancels future doses.
 *   6. Step-6 triage events: order status changes, safety-warning override,
 *      substitution, reconciliation (and a cross-patient encounter refused),
 *      pharmacy compliance, lot quarantine/release/recall, ICU observation /
 *      device / infusion, external referral, problem list, care plan (and an
 *      intervention's task closing with TaskCompleted).
 *   7. Redelivering everything creates no new task, notification or dose; no
 *      dead letters.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-orders-results-medication.ts
 */
import { prisma } from "../src/lib/db";
import { registerPatient } from "../src/lib/patient/registration";
import { openEncounter } from "../src/lib/hospital/encounter";
import { placeLabOrder } from "../src/lib/hospital/labOrder";
import { placeImagingOrder } from "../src/lib/hospital/imagingOrder";
import { collectSpecimen, receiveSpecimen, acceptSpecimen, rejectSpecimen, recollectSpecimen } from "../src/lib/hospital/specimenLifecycle";
import { enterResult, verifyResult, acknowledgeResult, amendResult } from "../src/lib/hospital/labResultLifecycle";
import { scheduleStudy, rescheduleStudy, checkInStudy, startStudy, completeStudy } from "../src/lib/hospital/imagingStudyLifecycle";
import { enterReport, verifyReport, acknowledgeReport } from "../src/lib/hospital/imagingReportLifecycle";
import {
  createMedicationOrder, verifyMedicationOrder, dispenseMedication, administerMedication, discontinueMedicationOrder,
  holdMedicationOrder, resubmitMedicationOrder, acknowledgeSafetyWarning, AdministrationNotDueError,
} from "../src/lib/hospital/medicationLifecycle";
import { sweepMedicationSchedule } from "../src/lib/hospital/marSweep";
import { generateAdministrationSchedule } from "../src/lib/hospital/medicationSchedule";
import { recordSubstitution, recordStorageCheck, quarantinePharmacyLot, releasePharmacyQuarantine, createRecall, closeRecall } from "../src/lib/hospital/pharmacy";
import { recordReconciliation } from "../src/lib/hospital/reconciliation";
import { recordObservation, recordDevice, updateDeviceStatus, recordInfusion, updateInfusionStatus } from "../src/lib/hospital/icu";
import { createExternalReferral, transitionExternalReferral } from "../src/lib/hospital/diagnosticsAdvanced";
import { addDiagnosisToProblemList } from "../src/lib/hospital/problemList";
import { createCarePlan, addIntervention, completeIntervention, closeCarePlan } from "../src/lib/hospital/carePlan";
import { assignNurse } from "../src/lib/hospital/nursingAssignment";
import { linkMedicationToItem, SYSTEM_ACTOR } from "../src/lib/hospital/inventory/itemMedicationLink";
import { createAdjustment } from "../src/lib/hospital/inventory/adjustment";
import { runTick } from "../src/lib/runner/tick";
import { tickWorkflows } from "../src/lib/workflows/engine";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const settle = <T>(p: Promise<T>) => p.then(() => true, () => false);
const drain = async () => { for (let i = 0; i < 5; i++) if (!(await runTick({ budgetMs: 20_000 })).moreWork) break; };

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const staffOf = (role: "DOCTOR" | "NURSE" | "PHARMACIST") =>
    prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(facilityId), { user: { role } }] }, orderBy: { id: "asc" } });
  const [doctor, nurse, pharmacist] = [await staffOf("DOCTOR"), await staffOf("NURSE"), await staffOf("PHARMACIST")];
  const by = doctor.userId;
  const patient = await registerPatient({ facilityId, byUserId: by, fullName: `Step6 Gate ${run}`, sex: "F", ageYears: 58 });
  const enc = await openEncounter({ facilityId, patientId: patient.id, type: "IPD", chiefComplaint: "Observation", byUserId: by });

  const outbox = (where: Record<string, unknown>) => prisma.domainEventOutbox.findMany({ where, orderBy: { seq: "asc" } });
  const ofType = (type: string, aggregateId: string) => outbox({ eventType: type, aggregateId });
  const one = async (type: string, aggregateId: string) => {
    const e = await ofType(type, aggregateId);
    return e.length === 1 ? { ...e[0], p: e[0].payload as Record<string, unknown> } : null;
  };
  const tx = <T>(fn: (t: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>) => prisma.$transaction(fn);

  // ── 1. Lab order, specimen ────────────────────────────────────────────────
  const lab = await placeLabOrder({ facilityId, staffId: doctor.id, byUserId: by, encounterId: enc.id, patientId: patient.id, testName: `Potassium ${run}`, category: "Biochemistry", priority: "STAT" });
  const dup = await placeLabOrder({ facilityId, staffId: doctor.id, byUserId: by, encounterId: enc.id, patientId: patient.id, testName: `Potassium ${run}`, category: "Biochemistry", priority: "STAT" });
  const placed = await one("LabOrderPlaced", lab.order.id);
  report("placeLabOrder emits LabOrderPlaced once, correlated by the encounter; a 15 s resubmission emits nothing",
    dup.duplicate && placed?.correlationId === enc.id && placed.p.priority === "STAT" && placed.p.orderId === lab.order.orderId);
  const specimen = lab.specimen!;
  await tx((t) => collectSpecimen(t, specimen.id, nurse.id, undefined, nurse.userId));
  const collected = await one("SpecimenCollected", specimen.id);
  report("collectSpecimen emits SpecimenCollected (LAB_ORDER)", collected?.p.specimenSource === "LAB_ORDER" && collected.p.labOrderId === lab.order.id);
  await tx((t) => rejectSpecimen(t, specimen.id, "HEMOLYZED", nurse.id, undefined, nurse.userId));
  const recollected = await tx((t) => recollectSpecimen(t, specimen.id, undefined, nurse.userId));
  const rej = await one("SpecimenStatusChanged", specimen.id);
  const rec = await one("SpecimenStatusChanged", recollected.id);
  report("rejectSpecimen → SpecimenStatusChanged COLLECTED → REJECTED with the reason code", rej?.p.from === "COLLECTED" && rej.p.to === "REJECTED" && rej.p.rejectionReason === "HEMOLYZED");
  report("recollectSpecimen → the new specimen, null → COLLECTION_PENDING, linked to the rejected one", rec?.p.from === null && rec.p.to === "COLLECTION_PENDING" && rec.p.recollectionOfSpecimenId === specimen.id);

  // ── 2. Critical lab result ────────────────────────────────────────────────
  await tx((t) => collectSpecimen(t, recollected.id, nurse.id));
  await tx((t) => receiveSpecimen(t, recollected.id, nurse.id));
  await tx((t) => acceptSpecimen(t, recollected.id, nurse.id));
  const result = await tx((t) => enterResult(t, { labOrderId: lab.order.id, specimenId: recollected.id, value: "6.9", isCritical: true }));
  await tx((t) => verifyResult(t, result.id, doctor.id, by));
  const released = await one("LabResultReleased", result.id);
  report("LabResultReleased is correlated by the encounter (was its own correlation)", released?.correlationId === enc.id && released.p.critical === true);
  await drain();
  const critKey = `CRITICAL_RESULT_FOLLOW_UP:${result.id}`;
  const critTask = () => prisma.task.findUnique({ where: { facilityId_idempotencyKey: { facilityId, idempotencyKey: critKey } } });
  report("task-generator: a critical result opens a STAT task", (await critTask())?.status === "OPEN" && (await critTask())?.priority === "STAT");
  const critNotes = await prisma.notification.findMany({ where: { sourceEventId: released!.eventId } });
  report("notification-dispatch: one CRITICAL notification to the ordering doctor, no value in it",
    critNotes.length === 1 && critNotes[0].recipientStaffId === doctor.id && critNotes[0].priority === "CRITICAL" && !`${critNotes[0].title}${critNotes[0].body ?? ""}`.includes("6.9"));
  const acked = await tx((t) => acknowledgeResult(t, result.id, doctor.id, by));
  const ack = await one("CriticalResultAcknowledged", result.id);
  const expectMinutes = Math.floor((acked.acknowledgedAt!.getTime() - acked.verifiedAt!.getTime()) / 60_000);
  report("acknowledgeResult → CriticalResultAcknowledged on LAB_RESULT, minutesToAcknowledge from the stored timestamps",
    ack?.aggregateType === "LAB_RESULT" && ack.p.resultKind === "LAB" && ack.p.minutesToAcknowledge === expectMinutes && ack.p.acknowledgedByStaffId === doctor.id);
  await drain();
  report("…and the critical-result task completes", (await critTask())?.status === "COMPLETED");
  const amended = await tx((t) => amendResult(t, result.id, { value: "5.9", reason: "re-run", amendedByStaffId: doctor.id }, by));
  const amend = await one("DiagnosticReportAmended", result.id);
  report("amendResult → DiagnosticReportAmended on the original's aggregate, naming the new version",
    amend?.aggregateType === "LAB_RESULT" && amend.p.amendedId === amended.amended.id && amend.p.supersedesId === result.id && amend.p.version === 2);

  // Batch 4 decision 1: one critical result → exactly one task; the workflow escalates it.
  const workflowTasksFor = async (releaseEventId: string) => {
    const inst = await prisma.workflowInstance.findMany({ where: { triggerEventId: releaseEventId }, select: { id: true } });
    return { instances: inst.length, tasks: await prisma.task.count({ where: { workflowInstanceId: { in: inst.map((i) => i.id) } } }) };
  };
  const fireSlaTimers = async (releaseEventId: string) => {
    const inst = await prisma.workflowInstance.findMany({ where: { triggerEventId: releaseEventId }, select: { id: true } });
    await prisma.workflowTimer.updateMany({ where: { workflowInstanceId: { in: inst.map((i) => i.id) }, kind: "SLA", status: "PENDING" }, data: { availableAt: new Date(Date.now() - 1000) } });
    return tickWorkflows({});
  };
  const wf1 = await workflowTasksFor(released!.eventId);
  report("critical-lab-review ran for the result but created no task of its own", wf1.instances === 1 && wf1.tasks === 0, JSON.stringify(wf1));
  await fireSlaTimers(released!.eventId);
  report("An SLA breach after acknowledgement escalates nothing (the task is closed)",
    (await critTask())?.status === "COMPLETED" && (await ofType("TaskUpdated", (await critTask())!.id)).length === 0);
  const lab2 = await placeLabOrder({ facilityId, staffId: doctor.id, byUserId: by, encounterId: enc.id, patientId: patient.id, testName: `Sodium ${run}`, category: "Biochemistry", priority: "STAT" });
  await tx((t) => collectSpecimen(t, lab2.specimen!.id, nurse.id));
  await tx((t) => receiveSpecimen(t, lab2.specimen!.id, nurse.id));
  await tx((t) => acceptSpecimen(t, lab2.specimen!.id, nurse.id));
  const result2 = await tx((t) => enterResult(t, { labOrderId: lab2.order.id, specimenId: lab2.specimen!.id, value: "118", isCritical: true }));
  await tx((t) => verifyResult(t, result2.id, doctor.id, by));
  const released2 = await one("LabResultReleased", result2.id);
  await drain();
  const critTask2 = () => prisma.task.findUniqueOrThrow({ where: { facilityId_idempotencyKey: { facilityId, idempotencyKey: `CRITICAL_RESULT_FOLLOW_UP:${result2.id}` } } });
  const before2 = await critTask2();
  const wf2 = await workflowTasksFor(released2!.eventId);
  report("One critical lab result → exactly one task", wf2.instances === 1 && wf2.tasks === 0 && before2.status === "OPEN");
  const fired = await fireSlaTimers(released2!.eventId);
  const after2 = await critTask2();
  const esc = await one("TaskUpdated", after2.id);
  report("An SLA breach escalates that same task (reassigned to HOSPITAL_ADMIN, STAT) and creates none",
    fired.escalated >= 1 && after2.id === before2.id && after2.assignedRole === "HOSPITAL_ADMIN" && after2.priority === "STAT"
      && (await workflowTasksFor(released2!.eventId)).tasks === 0
      && esc?.eventVersion === 2 && esc.p.escalated === true && (esc.p.changes as string[]).includes("ASSIGNED_ROLE"));

  // ── 3. Imaging ────────────────────────────────────────────────────────────
  const img = await placeImagingOrder({ facilityId, staffId: doctor.id, byUserId: by, encounterId: enc.id, patientId: patient.id, modality: "CT", studyDescription: `CT head ${run}`, priority: "URGENT" });
  const imgPlaced = await one("ImagingOrderPlaced", img.order.id);
  report("placeImagingOrder emits ImagingOrderPlaced with the modality code", imgPlaced?.p.priority === "URGENT" && imgPlaced.p.modality === "CT" && imgPlaced.correlationId === enc.id);
  const when = new Date(Date.now() + 2 * 3_600_000 + Math.floor(Math.random() * 3_600_000));
  const study = await tx((t) => scheduleStudy(t, { imagingOrderId: img.order.id, facilityId, patientId: patient.id, encounterId: enc.id, modality: "CT", scheduledAt: when }, by));
  await tx((t) => rescheduleStudy(t, study.id, null, new Date(when.getTime() + 3_600_000), undefined, by));
  const studyEvents = (await ofType("ImagingStudyStatusChanged", study.id)).map((e) => e.payload as Record<string, unknown>);
  report("scheduleStudy and rescheduleStudy → ImagingStudyStatusChanged (null → SCHEDULED, then rescheduled)",
    studyEvents.length === 2 && studyEvents[0].from === null && studyEvents[1].rescheduled === true);
  await tx((t) => checkInStudy(t, study.id));
  await tx((t) => startStudy(t, study.id, doctor.id));
  await tx((t) => completeStudy(t, study.id, {}, by));
  report("completeStudy → ImagingStudyCompleted", (await one("ImagingStudyCompleted", study.id))?.p.imagingOrderId === img.order.id);
  const rpt = await tx((t) => enterReport(t, { imagingOrderId: img.order.id, studyId: study.id, findings: "bleed", impression: "bleed", isCritical: true, reportedByStaffId: doctor.id }));
  await tx((t) => verifyReport(t, rpt.id, doctor.id, by));
  await tx((t) => acknowledgeReport(t, rpt.id, doctor.id, by));
  const rAck = await one("CriticalResultAcknowledged", rpt.id);
  report("acknowledgeReport → CriticalResultAcknowledged on IMAGING_REPORT", rAck?.aggregateType === "IMAGING_REPORT" && rAck.p.resultKind === "IMAGING" && rAck.p.reportId === rpt.id);
  const img2 = await placeImagingOrder({ facilityId, staffId: doctor.id, byUserId: by, encounterId: enc.id, patientId: patient.id, modality: "XRAY", studyDescription: `Outside film ${run}`, priority: "ROUTINE" });
  const noStudy = await tx((t) => enterReport(t, { imagingOrderId: img2.order.id, findings: "ok", impression: "ok", isCritical: false, reportedByStaffId: doctor.id }));
  await tx((t) => verifyReport(t, noStudy.id, doctor.id, by));
  report("A report with no linked study is still released (bug: it emitted nothing)", (await one("ImagingReportReleased", noStudy.id))?.correlationId === enc.id);

  // ── 4. Medication ─────────────────────────────────────────────────────────
  const pharmacy = await prisma.stockLocation.findFirstOrThrow({ where: { facilityId, name: "Central Pharmacy" } });
  const drugName = `Step6Drug${run}`;
  const item = await prisma.item.create({ data: { facilityId, sku: `S6-${run}`, name: drugName, category: "MEDICATION", baseUnit: "TABLET" } });
  await tx((t) => linkMedicationToItem(t, SYSTEM_ACTOR, { target: { scope: "FACILITY", facilityId }, drugName, itemId: item.id }));
  const lot = await prisma.itemLot.create({ data: { itemId: item.id, facilityId, lotNumber: `S6-LOT-${run}`, status: "ACTIVE", expiresAt: new Date("2029-01-01") } });
  await tx((t) => createAdjustment(t, { facilityId, itemId: item.id, lotId: lot.id, locationId: pharmacy.id, quantityDelta: 30, reason: "FOUND", requestedByStaffId: pharmacist.id, actorUserId: pharmacist.userId, idempotencyKey: `s6-seed-${run}` }));
  await assignNurse({ facilityId, nurseStaffId: nurse.id, patientId: patient.id, encounterId: enc.id, assignedByStaffId: nurse.id, byUserId: nurse.userId });

  const ordered = await createMedicationOrder({ facilityId, encounterId: enc.id, patientId: patient.id, orderingStaffId: doctor.id, drugName, dose: "1 tab", route: "PO", frequency: "TDS", overrideReason: "gate", byUserId: by });
  if (ordered.blocked) throw new Error("unexpected safety block");
  const orderId = ordered.order.id;
  const doses = () => prisma.medicationAdministration.findMany({ where: { medicationOrderId: orderId, lateForAdministrationId: null }, orderBy: { scheduledAt: "asc" } });
  report("No doses are scheduled before pharmacy verification", (await doses()).length === 0);
  await verifyMedicationOrder(orderId, pharmacist.id, pharmacist.userId);
  const verified = await one("MedicationVerified", orderId);
  report("verifyMedicationOrder emits MedicationVerified, correlated by the encounter", verified?.correlationId === enc.id);
  await drain();
  const sched = await doses();
  report("mar-scheduler writes 3 TDS doses, 8 h apart, starting at the verification time",
    sched.length === 3 && sched[0].scheduledAt.getTime() === verified!.occurredAt.getTime() && sched[1].scheduledAt.getTime() - sched[0].scheduledAt.getTime() === 8 * 3_600_000,
    sched.map((d) => d.scheduledAt.toISOString()).join(","));
  const disp = await dispenseMedication({ medicationOrderId: orderId, pharmacistStaffId: pharmacist.id, quantity: 9, quantityUnit: "TABLET", dispensingLocationId: pharmacy.id, byUserId: pharmacist.userId });
  const dispensed = await one("MedicationDispensed", disp.dispensingRecord.id);
  report("dispenseMedication emits MedicationDispensed for the record", dispensed?.p.orderId === orderId && dispensed.p.quantity === 9 && dispensed.p.partial === false);
  await administerMedication({ administrationId: sched[0].id, status: "GIVEN", administeredByStaffId: nurse.id, safetyChecksConfirmed: true, byUserId: nurse.userId });
  report("administerMedication (GIVEN) emits MedicationAdministered", (await one("MedicationAdministered", sched[0].id))?.p.orderId === orderId);
  await administerMedication({ administrationId: sched[1].id, status: "MISSED", reasonCode: "patient-away", byUserId: nurse.userId });
  const nurseMissed = await one("MedicationDoseMissed", sched[1].id);
  report("administerMedication (MISSED) emits MedicationDoseMissed missedBy NURSE (SENSITIVE)", nurseMissed?.p.missedBy === "NURSE");

  // ── 5. MAR sweep ──────────────────────────────────────────────────────────
  // A dose that fell due 2 h ago (beyond the 60 min grace) on this active order.
  // Written by the fixture rather than by moving a scheduled dose, so the
  // mar-scheduler's own slots stay untouched for the redelivery check.
  await generateAdministrationSchedule(orderId, "OD", 1, { from: new Date(Date.now() - 2 * 3_600_000) });
  const overdue = (await doses())[0];
  const sweep = await sweepMedicationSchedule({});
  const swept = await prisma.medicationAdministration.findUniqueOrThrow({ where: { id: overdue.id } });
  const sweptEvent = await one("MedicationDoseMissed", overdue.id);
  report("The sweep marks the overdue dose MISSED (not-recorded) and emits MedicationDoseMissed missedBy SWEEP",
    sweep.missed >= 1 && swept.status === "MISSED" && swept.reasonCode === "not-recorded" && sweptEvent?.p.missedBy === "SWEEP");
  report("A second sweep marks nothing again for that dose", (await sweepMedicationSchedule({})) && (await ofType("MedicationDoseMissed", overdue.id)).length === 1);
  await drain();
  const reviewTask = await prisma.task.findUnique({ where: { facilityId_idempotencyKey: { facilityId, idempotencyKey: `MISSED_DOSE_REVIEW:${overdue.id}` } } });
  report("task-generator: a missed dose opens a review task", reviewTask?.status === "OPEN" && reviewTask.priority === "URGENT");
  const missNotes = await prisma.notification.findMany({ where: { sourceEventId: sweptEvent!.eventId }, orderBy: { recipientStaffId: "asc" } });
  report("notification-dispatch: the prescriber and the assigned nurse are notified, once each",
    missNotes.map((n) => n.recipientStaffId).sort().join() === [doctor.id, nurse.id].sort().join());
  const late = await administerMedication({ administrationId: overdue.id, status: "GIVEN", administeredByStaffId: nurse.id, safetyChecksConfirmed: true, byUserId: nurse.userId });
  const lateAgain = await administerMedication({ administrationId: overdue.id, status: "GIVEN", administeredByStaffId: nurse.id, safetyChecksConfirmed: true, byUserId: nurse.userId }).then(() => null, (e) => e);
  const lateEvent = await one("MedicationAdministered", late.id);
  report("A late recording is a new row linked to the missed dose, which stays MISSED",
    late.id !== overdue.id && late.lateForAdministrationId === overdue.id && (await prisma.medicationAdministration.findUniqueOrThrow({ where: { id: overdue.id } })).status === "MISSED"
      && lateEvent?.p.lateForAdministrationId === overdue.id);
  report("…and it can be recorded only once", lateAgain instanceof AdministrationNotDueError);

  const stopOrder = await createMedicationOrder({ facilityId, encounterId: enc.id, patientId: patient.id, orderingStaffId: doctor.id, drugName, dose: "1 tab", route: "PO", frequency: "BD", overrideReason: "gate", byUserId: by });
  if (stopOrder.blocked) throw new Error("unexpected safety block");
  await holdMedicationOrder(stopOrder.order.id, "check dose", pharmacist.id, pharmacist.userId);
  await resubmitMedicationOrder(stopOrder.order.id, by);
  const statusChanges = (await ofType("MedicationOrderStatusChanged", stopOrder.order.id)).map((e) => e.payload as Record<string, unknown>);
  report("hold and resubmit emit MedicationOrderStatusChanged PHARMACY_REVIEW → HELD → PHARMACY_REVIEW",
    statusChanges.map((c) => `${c.from}>${c.to}`).join() === "PHARMACY_REVIEW>HELD,HELD>PHARMACY_REVIEW");
  await verifyMedicationOrder(stopOrder.order.id, pharmacist.id, pharmacist.userId);
  await drain();
  const before = await prisma.medicationAdministration.findMany({ where: { medicationOrderId: stopOrder.order.id, status: "DUE" } });
  const futureDue = before.filter((d) => d.scheduledAt.getTime() >= Date.now()).length;
  await discontinueMedicationOrder(stopOrder.order.id, "stopped", doctor.id, by);
  const stopEvent = (await ofType("MedicationOrderStatusChanged", stopOrder.order.id)).at(-1)?.payload as Record<string, unknown> | undefined;
  const leftDue = await prisma.medicationAdministration.count({ where: { medicationOrderId: stopOrder.order.id, status: "DUE", scheduledAt: { gte: new Date() } } });
  report("Discontinuing cancels the future scheduled doses in the same transaction, and says how many",
    futureDue >= 1 && leftDue === 0 && stopEvent?.to === "DISCONTINUED" && stopEvent.cancelledDoseCount === futureDue, `${futureDue} future`);

  // ── 6. The rest of step 6 ─────────────────────────────────────────────────
  const warning = await prisma.medicationSafetyWarning.create({ data: { medicationOrderId: orderId, severity: "DANGER", rule: "allergy-conflict", message: "gate warning" } });
  await acknowledgeSafetyWarning(warning.id, doctor.id, by, "clinically justified");
  const ov = await one("MedicationSafetyWarningOverridden", warning.id);
  report("acknowledgeSafetyWarning → MedicationSafetyWarningOverridden (no override text)", ov?.p.overridden === true && ov.p.severity === "DANGER" && !JSON.stringify(ov.p).includes("justified"));
  const sub = await recordSubstitution({ medicationOrderId: orderId, facilityId, replacementDrugName: "Generic", reason: "stock", authorizedByStaffId: pharmacist.id, byUserId: pharmacist.userId });
  report("recordSubstitution → MedicationSubstituted", (await one("MedicationSubstituted", sub.id))?.p.orderId === orderId);
  const recon = await recordReconciliation({ encounterId: enc.id, patientId: patient.id, facilityId, source: "ADMISSION", medicationName: "Home med", decision: "CONTINUED", reviewedByStaffId: doctor.id, byUserId: by });
  report("recordReconciliation → MedicationReconciliationRecorded (codes only)", (await one("MedicationReconciliationRecorded", recon.id))?.p.decision === "CONTINUED");
  const other = await registerPatient({ facilityId, byUserId: by, fullName: `Step6 Other ${run}`, sex: "M", ageYears: 40 });
  const crossPatient = await settle(recordReconciliation({ encounterId: enc.id, patientId: other.id, facilityId, source: "ADMISSION", medicationName: "x", decision: "NEW", reviewedByStaffId: doctor.id, byUserId: by }));
  report("Reconciliation refuses an encounter that is not the patient's (bug: it was accepted)", !crossPatient);
  const check = await recordStorageCheck({ facilityId, locationId: pharmacy.id, recordedValue: 11.5, unit: "C", status: "EXCURSION", recordedByStaffId: pharmacist.id, byUserId: pharmacist.userId });
  const comp = await one("PharmacyComplianceRecorded", check.id);
  report("recordStorageCheck → PharmacyComplianceRecorded STORAGE_CHECK / EXCURSION, no reading", comp?.p.storageStatus === "EXCURSION" && !JSON.stringify(comp.p).includes("11.5"));
  await quarantinePharmacyLot({ facilityId, itemLotId: lot.id, reason: "hold", byUserId: pharmacist.userId });
  await releasePharmacyQuarantine({ facilityId, itemLotId: lot.id, byUserId: pharmacist.userId });
  const recall = await createRecall({ facilityId, itemId: item.id, itemLotId: lot.id, reason: "supplier", createdByStaffId: pharmacist.id, byUserId: pharmacist.userId });
  await closeRecall({ recallId: recall.id, facilityId, closedByStaffId: pharmacist.id, byUserId: pharmacist.userId });
  const lotChanges = (await ofType("StockLotStatusChanged", lot.id)).map((e) => (e.payload as { cause: string; to: string }));
  report("Lot quarantine, release and recall → StockLotStatusChanged QUARANTINE, RELEASE, RECALL",
    lotChanges.map((c) => `${c.cause}:${c.to}`).join() === "QUARANTINE:QUARANTINED,RELEASE:ACTIVE,RECALL:RECALLED");
  report("createRecall and closeRecall → MedicationRecallStatusChanged OPEN then CLOSED",
    (await ofType("MedicationRecallStatusChanged", recall.id)).map((e) => (e.payload as { to: string }).to).join() === "OPEN,CLOSED");

  const obs = await recordObservation({ encounterId: enc.id, facilityId, type: "ABG", values: { pH: 7.21 }, recordedByStaffId: nurse.id, byUserId: nurse.userId });
  const obsEvent = await one("ObservationRecorded", obs.id);
  report("recordObservation → ObservationRecorded ICU_ABG, no values", obsEvent?.p.observationKind === "ICU_ABG" && !JSON.stringify(obsEvent.p).includes("7.21"));
  const device = await recordDevice({ encounterId: enc.id, facilityId, deviceType: "Central line", status: "ACTIVE", recordedByStaffId: nurse.id, byUserId: nurse.userId });
  await updateDeviceStatus({ deviceId: device.id, facilityId, status: "REMOVED", byUserId: nurse.userId });
  report("recordDevice / updateDeviceStatus → IcuDeviceStatusChanged null → ACTIVE → REMOVED",
    (await ofType("IcuDeviceStatusChanged", device.id)).map((e) => `${(e.payload as { from: string | null }).from}>${(e.payload as { to: string }).to}`).join() === "null>ACTIVE,ACTIVE>REMOVED");
  const inf = await recordInfusion({ encounterId: enc.id, facilityId, drugName: "Noradrenaline", rate: 5, rateUnit: "ml/h", recordedByStaffId: nurse.id, byUserId: nurse.userId });
  await updateInfusionStatus({ infusionId: inf.id, facilityId, status: "RUNNING", rate: 8, byUserId: nurse.userId });
  await updateInfusionStatus({ infusionId: inf.id, facilityId, status: "STOPPED", byUserId: nurse.userId });
  const infEvents = (await ofType("IcuInfusionStatusChanged", inf.id)).map((e) => e.payload as { to: string; rateChanged: boolean });
  report("Infusions → IcuInfusionStatusChanged (a rate change is flagged, never the rate)",
    infEvents.map((e) => `${e.to}:${e.rateChanged}`).join() === "RUNNING:false,RUNNING:true,STOPPED:false");
  const ref = await createExternalReferral({ facilityId, patientId: patient.id, encounterId: enc.id, externalLabName: "Ref Lab", sentByStaffId: doctor.id, byUserId: by });
  await transitionExternalReferral({ referralId: ref.id, facilityId, to: "SENT", actorStaffId: doctor.id, byUserId: by });
  report("External referral → ExternalLabReferralStatusChanged null → DRAFT → SENT",
    (await ofType("ExternalLabReferralStatusChanged", ref.id)).map((e) => (e.payload as { to: string }).to).join() === "DRAFT,SENT");
  const dx = await prisma.diagnosis.create({ data: { encounterId: enc.id, patientId: patient.id, diagnosis: `Hyperkalaemia ${run}`, type: "FINAL", diagnosedByStaffId: doctor.id } });
  const prob = await addDiagnosisToProblemList({ facilityId, diagnosisId: dx.id, byUserId: by });
  report("addDiagnosisToProblemList → ProblemListUpdated", (await one("ProblemListUpdated", prob.problem.id))?.p.diagnosisId === dx.id);
  const plan = await createCarePlan({ patientId: patient.id, encounterId: enc.id, facilityId, problem: "Falls", goal: "No falls", createdByStaffId: nurse.id, byUserId: nurse.userId });
  const iv = await addIntervention({ carePlanId: plan.id, facilityId, description: "Bed alarm", responsibleRole: "NURSE", createdByStaffId: nurse.id, byUserId: nurse.userId, createTask: true });
  await completeIntervention({ interventionId: iv.id, carePlanId: plan.id, facilityId, completedByStaffId: nurse.id, byUserId: nurse.userId });
  await closeCarePlan(plan.id, "COMPLETED", nurse.userId);
  const closeAgain = await settle(closeCarePlan(plan.id, "COMPLETED", nurse.userId));
  report("Care plan → CarePlanUpdated CREATED, INTERVENTION_ADDED, INTERVENTION_COMPLETED, CLOSED; a second close is refused",
    (await ofType("CarePlanUpdated", plan.id)).map((e) => (e.payload as { change: string }).change).join() === "CREATED,INTERVENTION_ADDED,INTERVENTION_COMPLETED,CLOSED" && !closeAgain);
  report("Completing an intervention closes its task with TaskCompleted (bug: it closed it without the event)",
    (await ofType("TaskCompleted", iv.taskId!)).length === 1);

  // ── 7. Redelivery and dead letters ────────────────────────────────────────
  await drain();
  const ids = (await outbox({ correlationId: enc.id })).map((e) => e.eventId);
  const counts = async () => [
    await prisma.task.count({ where: { encounterId: enc.id } }),
    await prisma.notification.count({ where: { encounterId: enc.id } }),
    await prisma.medicationAdministration.count({ where: { medicationOrder: { encounterId: enc.id } } }),
  ].join("/");
  const beforeReplay = await counts();
  await prisma.domainEventDelivery.updateMany({ where: { eventId: { in: ids } }, data: { status: "PENDING" } });
  await prisma.domainEventOutbox.updateMany({ where: { eventId: { in: ids } }, data: { status: "PENDING", processedAt: null } });
  await drain();
  report("Redelivering every event for the encounter creates no task, notification or dose", (await counts()) === beforeReplay, `${beforeReplay} → ${await counts()}`);
  const dead = await prisma.domainEventOutbox.count({ where: { eventId: { in: ids }, status: "DEAD_LETTER" } });
  report(`All ${ids.length} events processed, none dead-lettered`, dead === 0 && (await prisma.domainEventOutbox.count({ where: { eventId: { in: ids }, status: { not: "PROCESSED" } } })) === 0, String(dead));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
