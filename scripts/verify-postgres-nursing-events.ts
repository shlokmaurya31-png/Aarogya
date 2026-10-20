/**
 * Triage step 5b: nursing and task events.
 *
 *   1. Handoffs: createHandoff emits ClinicalHandoffStatusChanged (null →
 *      PENDING), acknowledgeHandoff (PENDING → ACKNOWLEDGED). A second
 *      acknowledgement fails and emits nothing. No handoff text in payloads.
 *   2. Nurse assignment: assignNurse emits ACTIVE; reassigning the patient
 *      emits ENDED (REASSIGNED) for the old row and ACTIVE for the new one;
 *      endAssignment emits ENDED (ENDED); a second end emits nothing.
 *   3. Nursing assessments: a draft emits nothing; complete, sign and amend
 *      emit NursingAssessmentRecorded with stage COMPLETED / SIGNED / AMENDED
 *      (the amendment names the assessment it supersedes); two concurrent
 *      signs produce exactly one SIGNED event.
 *   4. updateTask emits TaskUpdated with the changed fields as codes; a call
 *      that changes nothing emits nothing.
 *   5. Every event drains through the runner with no dead letter.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-nursing-events.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerPatient } from "../src/lib/patient/registration";
import { openEncounter } from "../src/lib/hospital/encounter";
import { createHandoff, acknowledgeHandoff } from "../src/lib/hospital/handoff";
import { assignNurse, endAssignment } from "../src/lib/hospital/nursingAssignment";
import { createAssessment, completeAssessment, signAssessment, amendAssessment } from "../src/lib/hospital/nursingAssessment";
import { createTask, updateTask } from "../src/lib/hospital/task";
import { runTick } from "../src/lib/runner/tick";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

const settle = <T>(p: Promise<T>) => p.then(() => true, () => false);

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const staffOf = (role: "DOCTOR" | "NURSE", skip = 0) => prisma.hospitalStaffProfile.findFirstOrThrow({
    where: { AND: [staffAtFacilityWhere(facilityId), { user: { role } }] }, orderBy: { id: "asc" }, skip,
  });
  const [doctor, nurseA, nurseB] = [await staffOf("DOCTOR"), await staffOf("NURSE"), await staffOf("NURSE", 1)];
  const by = nurseA.userId;
  const patient = await registerPatient({ facilityId, byUserId: by, fullName: `Nursing Events ${run}`, sex: "F", ageYears: 47 });
  const enc = await openEncounter({ facilityId, patientId: patient.id, type: "IPD", chiefComplaint: "Observation", byUserId: by });

  const eventsOf = (aggregateId: string, type: string) => prisma.domainEventOutbox.findMany({
    where: { aggregateId, eventType: type }, orderBy: { seq: "asc" }, select: { eventId: true, payload: true, correlationId: true, actorUserId: true },
  });
  const payloads = async (aggregateId: string, type: string) => (await eventsOf(aggregateId, type)).map((e) => e.payload as Record<string, unknown>);
  const allIds: string[] = [];
  const track = async (aggregateId: string, type: string) => { allIds.push(...(await eventsOf(aggregateId, type)).map((e) => e.eventId)); };

  // 1. Handoffs.
  const secret = `Handoff summary ${run}: watch the potassium`;
  const handoff = await createHandoff({ facilityId, patientId: patient.id, encounterId: enc.id, type: "NURSE", fromStaffId: nurseA.id, toStaffId: nurseB.id, urgency: "URGENT", summary: secret, safetyConcerns: "falls risk", byUserId: by });
  let h = await eventsOf(handoff.id, "ClinicalHandoffStatusChanged");
  const h0 = h[0]?.payload as Record<string, unknown> | undefined;
  report("createHandoff emits ClinicalHandoffStatusChanged null → PENDING, correlated by the encounter",
    h.length === 1 && h0?.from === null && h0?.to === "PENDING" && h0?.urgency === "URGENT" && h0?.handoffType === "NURSE" && h[0].correlationId === enc.id && h[0].actorUserId === by);
  report("…carrying IDs and codes only (no summary, no safety text)",
    !JSON.stringify(h0).includes("potassium") && !JSON.stringify(h0).includes("falls")
      && Object.keys(h0 ?? {}).sort().join() === "encounterId,escalationRequired,from,fromStaffId,handoffId,handoffType,patientId,to,toStaffId,urgency");
  await acknowledgeHandoff(handoff.id, nurseB.id, nurseB.userId);
  const again = await settle(acknowledgeHandoff(handoff.id, nurseB.id, nurseB.userId));
  h = await eventsOf(handoff.id, "ClinicalHandoffStatusChanged");
  const h1 = h[1]?.payload as Record<string, unknown> | undefined;
  report("acknowledgeHandoff emits PENDING → ACKNOWLEDGED with the acknowledging staff", h1?.from === "PENDING" && h1?.to === "ACKNOWLEDGED" && h1?.acknowledgedByStaffId === nurseB.id);
  report("A second acknowledgement fails and emits nothing", !again && h.length === 2, String(h.length));
  await track(handoff.id, "ClinicalHandoffStatusChanged");

  // 2. Nurse assignment.
  const a1 = await assignNurse({ facilityId, nurseStaffId: nurseA.id, patientId: patient.id, encounterId: enc.id, assignedByStaffId: nurseA.id, byUserId: by });
  const a1Events = await payloads(a1.id, "NurseAssignmentStatusChanged");
  report("assignNurse emits NurseAssignmentStatusChanged null → ACTIVE", a1Events.length === 1 && a1Events[0].from === null && a1Events[0].to === "ACTIVE" && a1Events[0].nurseStaffId === nurseA.id);
  const a2 = await assignNurse({ facilityId, nurseStaffId: nurseB.id, patientId: patient.id, encounterId: enc.id, assignedByStaffId: nurseA.id, byUserId: by });
  const a1After = await payloads(a1.id, "NurseAssignmentStatusChanged");
  const a2Events = await payloads(a2.id, "NurseAssignmentStatusChanged");
  report("Reassigning ends the old assignment (ENDED, endedBy REASSIGNED) and starts the new one",
    a1After.length === 2 && a1After[1].to === "ENDED" && a1After[1].endedBy === "REASSIGNED" && a2Events.length === 1 && a2Events[0].to === "ACTIVE");
  await endAssignment({ assignmentId: a2.id, facilityId, byUserId: by });
  const endAgain = await settle(endAssignment({ assignmentId: a2.id, facilityId, byUserId: by }));
  const a2After = await payloads(a2.id, "NurseAssignmentStatusChanged");
  report("endAssignment emits ACTIVE → ENDED (endedBy ENDED); a second end fails and emits nothing",
    !endAgain && a2After.length === 2 && a2After[1].from === "ACTIVE" && a2After[1].to === "ENDED" && a2After[1].endedBy === "ENDED");
  await track(a1.id, "NurseAssignmentStatusChanged");
  await track(a2.id, "NurseAssignmentStatusChanged");

  // 3. Nursing assessments.
  const draft = await createAssessment({ facilityId, patientId: patient.id, encounterId: enc.id, nurseStaffId: nurseA.id, findings: { skin: "intact" } });
  report("A draft assessment emits nothing (process step)", (await eventsOf(draft.id, "NursingAssessmentRecorded")).length === 0);
  await completeAssessment({ assessmentId: draft.id, encounterId: enc.id, byUserId: by });
  await signAssessment({ assessmentId: draft.id, encounterId: enc.id, byUserId: by });
  const amended = await amendAssessment({ assessmentId: draft.id, encounterId: enc.id, nurseStaffId: nurseA.id, findings: { skin: "pressure area" }, amendmentReason: "late entry", byUserId: by });
  const stages = (await payloads(draft.id, "NursingAssessmentRecorded")).map((p) => p.stage);
  const am = (await payloads(amended.id, "NursingAssessmentRecorded"))[0];
  report("complete and sign emit NursingAssessmentRecorded COMPLETED then SIGNED", stages.join() === "COMPLETED,SIGNED", stages.join());
  report("amend emits AMENDED on the new version, superseding the signed one",
    am?.stage === "AMENDED" && am.supersedesAssessmentId === draft.id && am.version === 2);
  report("…and no payload carries the findings", !JSON.stringify(am).includes("pressure") && !JSON.stringify(am).includes("skin"));
  const race = await createAssessment({ facilityId, patientId: patient.id, encounterId: enc.id, nurseStaffId: nurseA.id, findings: {} });
  await completeAssessment({ assessmentId: race.id, encounterId: enc.id, byUserId: by });
  const signs = await Promise.all([1, 2].map(() => settle(signAssessment({ assessmentId: race.id, encounterId: enc.id, byUserId: by }))));
  const signedEvents = (await payloads(race.id, "NursingAssessmentRecorded")).filter((p) => p.stage === "SIGNED");
  report("Two concurrent signs: one succeeds and exactly one SIGNED event exists", signs.filter(Boolean).length === 1 && signedEvents.length === 1);
  for (const a of [draft.id, amended.id, race.id]) await track(a, "NursingAssessmentRecorded");

  // 4. Task updates.
  const task = await prisma.$transaction((tx) => createTask(tx, {
    facilityId, title: `Gate task ${run}`, type: "GENERAL", priority: "ROUTINE", status: "OPEN", source: "MANUAL",
    patientId: patient.id, encounterId: enc.id, createdByStaffId: doctor.id,
  }, by));
  await updateTask({ taskId: task.id, facilityId, status: "IN_PROGRESS", startedAt: true, byUserId: by });
  await updateTask({ taskId: task.id, facilityId, ownerStaffId: nurseB.id, byUserId: by });
  await updateTask({ taskId: task.id, facilityId, ownerStaffId: nurseB.id, byUserId: by }); // no change
  const tu = await eventsOf(task.id, "TaskUpdated");
  const t0 = tu[0]?.payload as Record<string, unknown> | undefined;
  const t1 = tu[1]?.payload as Record<string, unknown> | undefined;
  report("updateTask emits TaskUpdated with STATUS + STARTED, OPEN → IN_PROGRESS",
    (t0?.changes as string[] | undefined)?.join() === "STATUS,STARTED" && t0?.fromStatus === "OPEN" && t0?.toStatus === "IN_PROGRESS" && tu[0].correlationId === enc.id);
  report("…an owner change emits OWNER with the new owner", (t1?.changes as string[] | undefined)?.join() === "OWNER" && t1?.ownerStaffId === nurseB.id);
  report("…and an update that changes nothing emits nothing", tu.length === 2, String(tu.length));
  await track(task.id, "TaskUpdated");

  // 5. Delivery.
  await runTick({ budgetMs: 20_000 });
  const statuses = await prisma.domainEventOutbox.groupBy({ by: ["status"], where: { eventId: { in: allIds } }, _count: true });
  report(`All ${allIds.length} events delivered, none dead-lettered`,
    statuses.length === 1 && statuses[0].status === "PROCESSED", statuses.map((s) => `${s.status}:${s._count}`).join(","));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
