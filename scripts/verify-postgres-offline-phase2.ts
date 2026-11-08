/**
 * Flagship 4a — offline nursing, phase 2 on the server: vitals, intake/output,
 * nursing tasks and PRN doses (docs/OFFLINE_NURSING_DESIGN.md §5, §6.2, §13.2).
 *
 *   1. The pack carries what the device needs: each patient's encounter, PRN
 *      orders with their limits and the doses of the last 24 hours (givable
 *      offline only when the prescriber allowed it), open tasks, recent vitals.
 *   2. Vitals and I/O offline: applied at the time they were measured, each
 *      with its event in the command's transaction; a replay is a no-op; a
 *      patient not assigned to the nurse, another facility's encounter, or
 *      values no measurement can have: refused, and kept for review.
 *   3. Tasks: completed offline; completed again on another device, the second
 *      is a note, not an error; completed after it was cancelled, it stays
 *      cancelled with the note.
 *   4. PRN: given offline within its limits, applied; online, a dose inside
 *      the minimum interval is refused; offline on a second device that didn't
 *      know, the dose is recorded and flagged CRITICAL (charge nurse due in 15
 *      minutes, pharmacist and prescriber told); the daily maximum likewise; a
 *      dose the device refused for its limits is a flag with no dose; PRN not
 *      allowed offline, controlled, or after the pack expired: refused, kept.
 *   5. The limits themselves: both or neither, and "offline allowed" only with
 *      them (service and database).
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { ensurePrimaryMembership } from "../prisma/seedData/staffMembership";
import { createMedicationOrder, givePrnDose, PrnLimitError } from "../src/lib/hospital/medicationLifecycle";
import { designateChargeNurse, issuePack, registerWardDevice, syncCommands } from "../src/lib/hospital/offline/service";
import { tag } from "./lib/shareFixture";

const PUNE = "fac-amc-pune";
const NOIDA = "fac-amc-noida";
const M = 60_000;
let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
let seq = 0;
const op = () => `p2-${tag}-${++seq}`;

async function staff(facilityId: string, role: "NURSE" | "DOCTOR" | "HOSPITAL_ADMIN") {
  seq += 1;
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId }, select: { id: true } });
  const user = await prisma.user.create({ data: { email: `p2-${role.toLowerCase()}-${tag}-${seq}@verify.aarogya`, passwordHash: "x", role, displayName: `P2 ${role} ${seq}` } });
  const s = await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId: dept.id, displayRole: role } });
  await ensurePrimaryMembership(prisma, user.id, facilityId, { isAdmin: role === "HOSPITAL_ADMIN" });
  return { userId: user.id, staffId: s.id, facilityId };
}

async function main() {
  const now = new Date();
  const at = (min: number) => new Date(now.getTime() + min * M);
  const admin = await staff(PUNE, "HOSPITAL_ADMIN");
  const nurse = await staff(PUNE, "NURSE");
  const charge = await staff(PUNE, "NURSE");
  const doctor = await staff(PUNE, "DOCTOR");
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId: PUNE }, select: { id: true } });
  const ward = await prisma.ward.create({ data: { facilityId: PUNE, name: `Phase 2 ward ${tag}`, wardType: "GENERAL", departmentId: dept.id } });
  await designateChargeNurse(admin, ward.id, { staffId: charge.staffId });
  const patient = async (assign: boolean) => {
    seq += 1;
    const p = await prisma.patient.create({ data: { uhid: `P2-${tag}-${seq}`, facilityId: PUNE, fullName: `Phase2 Patient ${seq}`, sex: "F" } });
    const e = await prisma.encounter.create({ data: { patientId: p.id, facilityId: PUNE, type: "IPD", status: "ADMITTED" } });
    const bed = await prisma.bed.create({ data: { wardId: ward.id, facilityId: PUNE, label: `P2-${tag}-${seq}` } });
    if (assign) await prisma.nursingAssignment.create({ data: { facilityId: PUNE, nurseStaffId: nurse.staffId, patientId: p.id, encounterId: e.id, bedId: bed.id, assignedByStaffId: admin.staffId, startAt: at(-60) } });
    return { patientId: p.id, encounterId: e.id };
  };
  const mine = await patient(true);
  const notMine = await patient(false);
  const noidaPatient = await prisma.patient.create({ data: { uhid: `P2N-${tag}`, facilityId: NOIDA, fullName: "Noida Patient", sex: "M" } });
  const noidaEnc = await prisma.encounter.create({ data: { patientId: noidaPatient.id, facilityId: NOIDA, type: "IPD", status: "ADMITTED" } });

  const prnOrder = async (drugName: string, limits: { min?: number; max?: number; offline?: boolean; controlled?: boolean }) => {
    const r = await createMedicationOrder({ facilityId: PUNE, encounterId: mine.encounterId, patientId: mine.patientId, orderingStaffId: doctor.staffId, drugName, dose: "1 tab", route: "ORAL", frequency: "PRN", prn: true, prnReason: "pain", prnMinIntervalMinutes: limits.min, prnMaxDosesPer24h: limits.max, prnOfflineAllowed: limits.offline, isControlled: limits.controlled, overrideReason: "gate", byUserId: doctor.userId });
    if (r.blocked) throw new Error("order blocked");
    await prisma.medicationOrder.update({ where: { id: r.order.id }, data: { status: "ACTIVE" } });
    return r.order;
  };
  const para = await prnOrder("Paracetamol", { min: 240, max: 4, offline: true });
  const ondansetron = await prnOrder("Ondansetron", { min: 60, max: 2, offline: true });
  const notOffline = await prnOrder("Ibuprofen", { min: 360, max: 3 });
  const tramadol = await prnOrder("Tramadol", { min: 360, max: 3, offline: true, controlled: true });
  const taskA = await prisma.task.create({ data: { facilityId: PUNE, title: "Turn the patient", type: "GENERAL", source: "MANUAL", patientId: mine.patientId, encounterId: mine.encounterId } });
  const taskB = await prisma.task.create({ data: { facilityId: PUNE, title: "Check the drain", type: "GENERAL", source: "MANUAL", patientId: mine.patientId, encounterId: mine.encounterId } });
  await prisma.vital.create({ data: { encounterId: mine.encounterId, recordedByStaffId: nurse.staffId, hr: 80, recordedAt: at(-120) } });

  const devA = await registerWardDevice(admin, { wardId: ward.id, label: `P2 tablet A ${tag}` });
  const devB = await registerWardDevice(admin, { wardId: ward.id, label: `P2 tablet B ${tag}` });
  const N = { userId: nurse.userId, staffId: nurse.staffId, facilityId: PUNE };
  const sync = (device: string, commands: Record<string, unknown>[], when = at(1)) => syncCommands(N, { deviceId: device, commands }, { now: when });

  // 1. The pack.
  const pack = await issuePack(N, { deviceId: devA.id }, { now });
  await issuePack(N, { deviceId: devB.id }, { now });
  const pp = pack.patients.find((p) => p.patientId === mine.patientId)!;
  report("The pack names each patient's encounter, open tasks and recent vitals", pp.encounterId === mine.encounterId && pp.tasks.length === 2 && pp.vitals.length === 1);
  const prnOf = (id: string) => pp.prn.find((o) => o.orderId === id);
  report("PRN orders come with their limits; givable offline only when allowed, never when controlled", prnOf(para.id)?.givableOffline === true && prnOf(para.id)?.minIntervalMinutes === 240 && prnOf(notOffline.id)?.givableOffline === false && prnOf(tramadol.id)?.givableOffline === false && prnOf(tramadol.id)?.onlineOnly === true);

  // 2. Vitals and I/O.
  const vitalsOp = { clientOperationId: op(), kind: "VITALS", encounterId: mine.encounterId, vitals: { hr: 112, sbp: 98, spo2: 93 }, deviceTime: at(-20).toISOString() };
  const s1 = await sync(devA.id, [vitalsOp, { clientOperationId: op(), kind: "INTAKE_OUTPUT", encounterId: mine.encounterId, ioType: "OUTPUT", category: "URINE", quantityMl: 350, deviceTime: at(-15).toISOString() }]);
  const v = await prisma.vital.findFirst({ where: { encounterId: mine.encounterId, hr: 112 } });
  const io = await prisma.intakeOutputRecord.findFirst({ where: { encounterId: mine.encounterId, quantityMl: 350 } });
  report("Vitals offline are applied at the time they were measured", s1.results[0].outcome === "APPLIED" && v?.recordedAt.getTime() === at(-20).getTime(), v?.recordedAt.toISOString());
  report("…and I/O too", s1.results[1].outcome === "APPLIED" && io?.recordedAt.getTime() === at(-15).getTime());
  report("…each with its event in the command's transaction", (await prisma.domainEventOutbox.count({ where: { eventType: "ObservationRecorded", aggregateId: { in: [v!.id, io!.id] } } })) === 2 && (await prisma.domainEventOutbox.count({ where: { eventType: "OfflineCommandRecorded", eventVersion: 2, facilityId: PUNE, payload: { path: ["encounterId"], equals: mine.encounterId } } })) === 2);
  const replay = await sync(devA.id, [vitalsOp], at(2));
  report("A replay is a no-op", replay.results[0].replayed && (await prisma.vital.count({ where: { encounterId: mine.encounterId, hr: 112 } })) === 1);
  const s2 = await sync(devA.id, [
    { clientOperationId: op(), kind: "VITALS", encounterId: notMine.encounterId, vitals: { hr: 70 }, deviceTime: at(-5).toISOString() },
    { clientOperationId: op(), kind: "VITALS", encounterId: noidaEnc.id, vitals: { hr: 70 }, deviceTime: at(-5).toISOString() },
    { clientOperationId: op(), kind: "VITALS", encounterId: mine.encounterId, vitals: { hr: 900 }, deviceTime: at(-5).toISOString() },
    { clientOperationId: op(), kind: "INTAKE_OUTPUT", encounterId: mine.encounterId, ioType: "OUTPUT", category: "TEARS", quantityMl: 10, deviceTime: at(-5).toISOString() },
  ]);
  report("A patient not assigned to the nurse: refused", s2.results[0].outcome === "REFUSED" && s2.results[0].refusalReason === "NOT_ASSIGNED");
  report("Another facility's encounter: refused as unknown", s2.results[1].refusalReason === "UNKNOWN_ENCOUNTER" && (await prisma.vital.count({ where: { encounterId: noidaEnc.id } })) === 0);
  report("Values no measurement can have: refused", s2.results[2].refusalReason === "INVALID_VALUES" && s2.results[3].refusalReason === "INVALID_VALUES");
  const kept = await prisma.offlineCommand.findMany({ where: { clientOperationId: { in: s2.results.map((r) => r.clientOperationId) } }, include: { conflicts: true } });
  report("…each kept as sent, for a person to review", kept.length === 4 && kept.every((c) => c.payload !== null && c.conflicts.some((x) => x.kind === "REFUSED_RECORD")) && JSON.stringify(kept.find((c) => c.refusalReason === "INVALID_VALUES" && c.kind === "VITALS")?.payload).includes("900"));

  // 3. Tasks.
  const t1 = await sync(devA.id, [{ clientOperationId: op(), kind: "TASK_COMPLETED", taskId: taskA.id, deviceTime: at(-10).toISOString() }]);
  const tA = await prisma.task.findUniqueOrThrow({ where: { id: taskA.id } });
  report("A task completed offline is completed, at the time it was done, with its event", t1.results[0].outcome === "APPLIED" && tA.status === "COMPLETED" && tA.completedAt?.getTime() === at(-10).getTime() && (await prisma.domainEventOutbox.count({ where: { eventType: "TaskCompleted", aggregateId: taskA.id } })) === 1);
  const t2 = await sync(devB.id, [{ clientOperationId: op(), kind: "TASK_COMPLETED", taskId: taskA.id, deviceTime: at(-8).toISOString() }]);
  report("Completed again on another device: a note, not an error", t2.results[0].outcome === "APPLIED" && /Also done/.test(t2.results[0].note ?? "") && (await prisma.domainEventOutbox.count({ where: { eventType: "TaskCompleted", aggregateId: taskA.id } })) === 1, t2.results[0].note ?? "");
  await prisma.task.update({ where: { id: taskB.id }, data: { status: "CANCELLED", cancelledAt: now } });
  const t3 = await sync(devA.id, [{ clientOperationId: op(), kind: "TASK_COMPLETED", taskId: taskB.id, deviceTime: at(-6).toISOString() }]);
  report("Completed after it was cancelled: kept with a note, the task stays cancelled", t3.results[0].outcome === "APPLIED" && /stays cancelled/.test(t3.results[0].note ?? "") && (await prisma.task.findUniqueOrThrow({ where: { id: taskB.id } })).status === "CANCELLED");

  // 4. PRN.
  const p1 = await sync(devA.id, [{ clientOperationId: op(), kind: "PRN_GIVEN", medicationOrderId: para.id, deviceTime: at(-30).toISOString() }]);
  const given = await prisma.medicationAdministration.findMany({ where: { medicationOrderId: para.id, status: "GIVEN" } });
  report("A PRN dose offline within its limits is applied, at its time, with its event", p1.results[0].outcome === "APPLIED" && given.length === 1 && given[0].administeredAt?.getTime() === at(-30).getTime() && (await prisma.domainEventOutbox.count({ where: { eventType: "MedicationAdministered", aggregateId: given[0].id } })) === 1);
  report("Online, a dose inside the minimum interval is refused", await givePrnDose({ orderId: para.id, facilityId: PUNE, administeredByStaffId: charge.staffId, byUserId: charge.userId }).then(() => false, (e) => e instanceof PrnLimitError && e.breach === "MIN_INTERVAL"));
  const p2 = await sync(devB.id, [{ clientOperationId: op(), kind: "PRN_GIVEN", medicationOrderId: para.id, deviceTime: at(-25).toISOString() }], at(3));
  report("Offline on a device that didn't know: the dose is recorded, and flagged CRITICAL", p2.results[0].outcome === "APPLIED_WITH_CONFLICT" && p2.results[0].conflicts.some((c) => c.kind === "PRN_LIMIT_BREACHED" && c.severity === "CRITICAL") && (await prisma.medicationAdministration.count({ where: { medicationOrderId: para.id, status: "GIVEN" } })) === 2);
  const breach = await prisma.offlineConflict.findFirstOrThrow({ where: { kind: "PRN_LIMIT_BREACHED", patientId: mine.patientId } });
  const bTask = await prisma.task.findUniqueOrThrow({ where: { id: breach.taskId! } });
  report("…the charge nurse's task due within 15 minutes; the pharmacist and the prescriber told",
    bTask.ownerStaffId === charge.staffId && bTask.priority === "STAT" && bTask.dueAt!.getTime() - at(3).getTime() <= 15 * M
    && (await prisma.task.count({ where: { idempotencyKey: { startsWith: `offline-conflict:${breach.commandId}:PRN_LIMIT_BREACHED:` } } })) === 2);
  const d1 = await sync(devA.id, [
    { clientOperationId: op(), kind: "PRN_GIVEN", medicationOrderId: ondansetron.id, deviceTime: at(-300).toISOString() },
    { clientOperationId: op(), kind: "PRN_GIVEN", medicationOrderId: ondansetron.id, deviceTime: at(-200).toISOString() },
    { clientOperationId: op(), kind: "PRN_GIVEN", medicationOrderId: ondansetron.id, deviceTime: at(-60).toISOString() },
  ], at(4));
  report("Past its daily maximum: the third dose is recorded and flagged CRITICAL", d1.results[0].outcome === "APPLIED" && d1.results[1].outcome === "APPLIED" && d1.results[2].conflicts.some((c) => c.kind === "PRN_LIMIT_BREACHED"), d1.results.map((r) => r.outcome).join(","));
  const r1 = await sync(devA.id, [{ clientOperationId: op(), kind: "PRN_BREACH_REFUSED", medicationOrderId: para.id, breach: "MIN_INTERVAL", deviceTime: at(-1).toISOString() }], at(5));
  report("A dose the device refused for its limits: a flag for the charge nurse, no dose", r1.results[0].conflicts.some((c) => c.kind === "PRN_BREACH_ATTEMPT") && (await prisma.medicationAdministration.count({ where: { medicationOrderId: para.id, status: "GIVEN" } })) === 2);
  const r2 = await sync(devA.id, [
    { clientOperationId: op(), kind: "PRN_GIVEN", medicationOrderId: notOffline.id, deviceTime: at(-1).toISOString() },
    { clientOperationId: op(), kind: "PRN_GIVEN", medicationOrderId: tramadol.id, deviceTime: at(-1).toISOString() },
    { clientOperationId: op(), kind: "PRN_GIVEN", medicationOrderId: para.id, deviceTime: new Date(new Date(pack.expiresAt).getTime() + 5 * M).toISOString() },
  ], new Date(new Date(pack.expiresAt).getTime() + 6 * M));
  report("PRN not allowed offline, controlled, or after the pack expired: refused, and kept for review",
    r2.results[0].refusalReason === "PRN_NOT_OFFLINE" && r2.results[1].refusalReason === "ONLINE_ONLY" && r2.results[2].refusalReason === "LEASE_EXPIRED" && r2.results.every((r) => r.conflicts.length === 1)
    && (await prisma.medicationAdministration.count({ where: { medicationOrderId: { in: [notOffline.id, tramadol.id] } } })) === 0, r2.results.map((r) => r.refusalReason).join(","));

  // 5. The limits themselves.
  const bad = (x: { min?: number; max?: number; offline?: boolean }) => prnOrder(`Bad ${tag}`, x).then(() => false, (e) => (e as Error).constructor.name === "BadPrnOrderError");
  report("PRN limits come together, and \"offline allowed\" only with them", (await bad({ min: 60 })) && (await bad({ offline: true })) && (await bad({ min: 0, max: 2 })));
  report("…and the database holds the same rule", await prisma.medicationOrder.update({ where: { id: notOffline.id }, data: { prnMinIntervalMinutes: null } }).then(() => false, () => true)
    && await prisma.medicationOrder.update({ where: { id: notOffline.id }, data: { prn: false, prnMinIntervalMinutes: null, prnMaxDosesPer24h: null, prnOfflineAllowed: true } }).then(() => false, () => true));

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
