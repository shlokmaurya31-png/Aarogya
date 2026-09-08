/**
 * Phase 6.7 concurrency verification: proves the guarded-updateMany CAS
 * idiom applied to Task completion, NursingAssessment lifecycle,
 * NursingAssignment (partial unique index), Handoff acknowledgement, and
 * ClinicalNote amendment all hold under genuine concurrent PostgreSQL
 * transactions — mirroring scripts/verify-postgres-medication-concurrency.ts's
 * structure. This codebase has no automated DB-backed test harness;
 * concurrency is verified via real parallel execution, by established
 * convention. Also re-runs the Phase 6.6 medication-administration
 * regression check separately (see README note at the bottom) and
 * verifies the CarePlanIntervention IDOR fix.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-nursing-concurrency.ts
 */
import { PrismaClient } from "@prisma/client";
import { completeTask, TaskConcurrencyError } from "../src/lib/hospital/task";
import { createAssessment, completeAssessment, signAssessment, amendAssessment, AssessmentConcurrencyError } from "../src/lib/hospital/nursingAssessment";
import { assignNurse, NursingAssignmentConcurrencyError } from "../src/lib/hospital/nursingAssignment";
import { createHandoff, acknowledgeHandoff, HandoffAlreadyAcknowledgedError } from "../src/lib/hospital/handoff";
import { amendNote, NoteConcurrencyError } from "../src/lib/hospital/clinicalNote";
import { addIntervention, completeIntervention } from "../src/lib/hospital/carePlan";
import { NotFoundError } from "../src/lib/auth/rbac";

const prisma = new PrismaClient();
const runId = Date.now();
let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function main() {
  const facility = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const nurses = await prisma.hospitalStaffProfile.findMany({ where: { facilityId: facility.id, user: { role: "NURSE" } }, take: 2 });
  if (nurses.length < 2) throw new Error("Expected at least 2 seeded NURSE staff profiles at Aarogya Medical Centre.");
  const [nurseA, nurseB] = nurses;
  const encounter = await prisma.encounter.findFirstOrThrow({ where: { facilityId: facility.id } });
  const patientId = encounter.patientId;

  // ── Case A: two concurrent completeTask calls on the SAME task ──
  {
    const task = await prisma.task.create({
      data: { facilityId: facility.id, title: `Race task ${runId}`, type: "GENERAL", patientId, encounterId: encounter.id, createdByStaffId: nurseA.id, status: "OPEN" },
    });
    const attempt = () => completeTask({ taskId: task.id, facilityId: facility.id, completedByStaffId: nurseA.id, byUserId: nurseA.userId });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failedConcurrency = results.filter((r) => r.status === "rejected" && r.reason instanceof TaskConcurrencyError).length;
    const finalTask = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    // Filtered in JS rather than via a JSON-path where-clause — Prisma's JSON
    // filter type shape differs between the SQLite dev client and the
    // Postgres client this script actually targets.
    const auditCandidates = await prisma.auditEvent.findMany({ where: { type: "hospital.task.completed" } });
    const auditCount = auditCandidates.filter((e) => (e.detail as { taskId?: string } | null)?.taskId === task.id).length;
    report(
      "CASE A: two concurrent completeTask calls on the same task — exactly one succeeds, exactly one COMPLETED, exactly one audit event",
      succeeded === 1 && failedConcurrency === 1 && finalTask.status === "COMPLETED" && auditCount === 1,
      `succeeded=${succeeded}, failedConcurrency=${failedConcurrency}, finalStatus=${finalTask.status}, auditEvents=${auditCount}`
    );
  }

  // ── Case B1: two concurrent signAssessment calls on the same COMPLETED assessment ──
  let signedAssessmentId = "";
  {
    const draft = await createAssessment({ facilityId: facility.id, patientId, encounterId: encounter.id, nurseStaffId: nurseA.id, findings: { general: "Alert, oriented" } });
    const completed = await completeAssessment({ assessmentId: draft.id, encounterId: encounter.id });
    const attempt = () => signAssessment({ assessmentId: completed.id, encounterId: encounter.id });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failedConcurrency = results.filter((r) => r.status === "rejected" && r.reason instanceof AssessmentConcurrencyError).length;
    const finalAssessment = await prisma.nursingAssessment.findUniqueOrThrow({ where: { id: completed.id } });
    signedAssessmentId = finalAssessment.id;
    report(
      "CASE B1: two concurrent signAssessment calls on the same assessment — exactly one succeeds, exactly one SIGNED",
      succeeded === 1 && failedConcurrency === 1 && finalAssessment.status === "SIGNED",
      `succeeded=${succeeded}, failedConcurrency=${failedConcurrency}, finalStatus=${finalAssessment.status}`
    );
  }

  // ── Case B2: two concurrent amendAssessment calls on the same SIGNED/current assessment ──
  {
    const attempt = () =>
      amendAssessment({ assessmentId: signedAssessmentId, encounterId: encounter.id, nurseStaffId: nurseA.id, findings: { general: "Amended finding" }, amendmentReason: `race-${runId}` });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failedConcurrency = results.filter((r) => r.status === "rejected" && r.reason instanceof AssessmentConcurrencyError).length;
    const currentVersions = await prisma.nursingAssessment.count({ where: { encounterId: encounter.id, isCurrent: true } });
    report(
      "CASE B2: two concurrent amendAssessment calls on the same signed assessment — exactly one succeeds, exactly one current version afterward",
      succeeded === 1 && failedConcurrency === 1 && currentVersions === 1,
      `succeeded=${succeeded}, failedConcurrency=${failedConcurrency}, currentVersions=${currentVersions}`
    );
  }

  // ── Case D: two concurrent assignNurse calls for the SAME patient — the real invariant is "at most one active assignment afterward", not which call wins. ──
  {
    // A dedicated patient for this case so pre-existing seeded assignments don't skew the count.
    const dedicatedPatient = await prisma.patient.create({
      data: { facilityId: facility.id, uhid: `P67-RACE-${runId}`, fullName: `Race Patient ${runId}`, sex: "female", dob: new Date("1990-01-01") },
    });
    const attempt = (nurseStaffId: string) =>
      assignNurse({ facilityId: facility.id, nurseStaffId, patientId: dedicatedPatient.id, assignedByStaffId: nurseA.id, byUserId: nurseA.userId });
    const results = await Promise.allSettled([attempt(nurseA.id), attempt(nurseB.id)]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failedConcurrency = results.filter((r) => r.status === "rejected" && r.reason instanceof NursingAssignmentConcurrencyError).length;
    const activeCount = await prisma.nursingAssignment.count({ where: { patientId: dedicatedPatient.id, endAt: null } });
    report(
      "CASE D: two concurrent assignNurse calls for the same patient — at most one active NursingAssignment afterward (partial unique index holds)",
      activeCount === 1 && succeeded >= 1,
      `succeeded=${succeeded}, failedConcurrency=${failedConcurrency}, activeCount=${activeCount}`
    );
  }

  // ── Case E: two concurrent acknowledgeHandoff calls on the same PENDING handoff ──
  {
    const handoff = await createHandoff({ facilityId: facility.id, patientId, encounterId: encounter.id, type: "NURSE", fromStaffId: nurseA.id, summary: `Race handoff ${runId}`, byUserId: nurseA.userId });
    const attempt = () => acknowledgeHandoff(handoff.id, nurseB.id, nurseB.userId);
    const results = await Promise.allSettled([attempt(), attempt()]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failedConcurrency = results.filter((r) => r.status === "rejected" && r.reason instanceof HandoffAlreadyAcknowledgedError).length;
    const finalHandoff = await prisma.clinicalHandoff.findUniqueOrThrow({ where: { id: handoff.id } });
    report(
      "CASE E: two concurrent acknowledgeHandoff calls on the same handoff — exactly one succeeds, exactly one ACKNOWLEDGED",
      succeeded === 1 && failedConcurrency === 1 && finalHandoff.status === "ACKNOWLEDGED",
      `succeeded=${succeeded}, failedConcurrency=${failedConcurrency}, finalStatus=${finalHandoff.status}`
    );
  }

  // ── Case F: two concurrent amendNote calls on the same signed ClinicalNote ──
  {
    const originalNote = await prisma.clinicalNote.create({
      data: { encounterId: encounter.id, authorStaffId: nurseA.id, type: "PROGRESS", content: { assessment: "Original note" }, status: "SIGNED", signedAt: new Date() },
    });
    const attempt = () =>
      amendNote({ supersedesId: originalNote.id, encounterId: encounter.id, authorStaffId: nurseA.id, authorRole: "NURSE", type: "PROGRESS", content: { assessment: "Amended note" }, amendmentReason: `race-${runId}`, byUserId: nurseA.userId });
    const results = await Promise.allSettled([attempt(), attempt()]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failedConcurrency = results.filter((r) => r.status === "rejected" && r.reason instanceof NoteConcurrencyError).length;
    const finalOriginal = await prisma.clinicalNote.findUniqueOrThrow({ where: { id: originalNote.id } });
    const replacements = await prisma.clinicalNote.count({ where: { supersedesId: originalNote.id } });
    report(
      "CASE F: two concurrent amendNote calls on the same signed note — exactly one succeeds, exactly one SUPERSEDED, exactly one replacement note",
      succeeded === 1 && failedConcurrency === 1 && finalOriginal.status === "SUPERSEDED" && replacements === 1,
      `succeeded=${succeeded}, failedConcurrency=${failedConcurrency}, originalStatus=${finalOriginal.status}, replacements=${replacements}`
    );
  }

  // ── IDOR: completeIntervention must reject an interventionId that belongs to a DIFFERENT carePlanId ──
  {
    const cp1 = await prisma.carePlan.create({ data: { patientId, facilityId: facility.id, problem: `CP1 ${runId}`, goal: "Goal 1", createdByStaffId: nurseA.id } });
    const cp2 = await prisma.carePlan.create({ data: { patientId, facilityId: facility.id, problem: `CP2 ${runId}`, goal: "Goal 2", createdByStaffId: nurseA.id } });
    const iv2 = await addIntervention({ carePlanId: cp2.id, facilityId: facility.id, description: "Belongs to CP2", responsibleRole: "Nursing", createdByStaffId: nurseA.id, byUserId: nurseA.userId });
    const attempt = await completeIntervention({ interventionId: iv2.id, carePlanId: cp1.id, facilityId: facility.id, completedByStaffId: nurseA.id, byUserId: nurseA.userId })
      .then(() => ({ ok: true as const }))
      .catch((err) => ({ ok: false as const, err }));
    report("IDOR: completeIntervention rejects an interventionId belonging to a different carePlanId", !attempt.ok && attempt.err instanceof NotFoundError);
  }

  // ── Task-linked intervention completion is transactional: completing the intervention also completes its linked Task ──
  {
    const cp = await prisma.carePlan.create({ data: { patientId, facilityId: facility.id, problem: `CP-linked ${runId}`, goal: "Goal", createdByStaffId: nurseA.id } });
    const iv = await addIntervention({ carePlanId: cp.id, facilityId: facility.id, description: "Linked to a task", responsibleRole: "Nursing", createdByStaffId: nurseA.id, byUserId: nurseA.userId, createTask: true });
    if (!iv.taskId) throw new Error("Expected addIntervention with createTask:true to link a taskId.");
    await completeIntervention({ interventionId: iv.id, carePlanId: cp.id, facilityId: facility.id, completedByStaffId: nurseA.id, byUserId: nurseA.userId });
    const linkedTask = await prisma.task.findUniqueOrThrow({ where: { id: iv.taskId } });
    report("Task-linked intervention: completing the intervention also completes its linked Task", linkedTask.status === "COMPLETED", `taskStatus=${linkedTask.status}`);
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  console.log("\nNote: re-run scripts/verify-postgres-medication-concurrency.ts separately against the same database to confirm the Phase 6.6 medication-administration protection is unaffected by this migration (Case C in the Phase 6.7 plan).");
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
