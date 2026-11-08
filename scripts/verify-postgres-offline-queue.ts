/**
 * Flagship 4b — the charge nurse's offline queue (docs/OFFLINE_NURSING_DESIGN.md §13.3).
 *
 *   1. The queue: the charge nurse on now sees their wards' open conflicts,
 *      CRITICAL first (a possible double dose, a refused record), and the
 *      doses taken over from a device until confirmed; another nurse sees none.
 *   2. The 15-minute escalation: not before 15 minutes; then once, with the
 *      pharmacists' STAT task, a notification each, and its event.
 *   3. Resolving: only the charge nurse on now, with a known resolution and a
 *      reason; the conflict's task is completed; audited with the reason, with
 *      its event; never twice; another facility's nurse gets a 404.
 *   4. Confirming a takeover in person: the same rules.
 *   5. After a handover, the queue is the incoming charge nurse's.
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { ensurePrimaryMembership } from "../prisma/seedData/staffMembership";
import { administerMedication } from "../src/lib/hospital/medicationLifecycle";
import { issuePack, overrideLease, registerWardDevice, syncCommands } from "../src/lib/hospital/offline/service";
import { assignChargeShift } from "../src/lib/hospital/offline/chargeShift";
import { confirmOverride, conflictQueue, escalateOfflineConflicts, resolveConflict } from "../src/lib/hospital/offline/queue";
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
const refusedWith = <T>(p: Promise<T>, name: string) => p.then(() => false, (e) => (e as Error).constructor.name === name);
let seq = 0;

async function staff(facilityId: string, role: "NURSE" | "DOCTOR" | "HOSPITAL_ADMIN" | "PHARMACIST") {
  seq += 1;
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId }, select: { id: true } });
  const user = await prisma.user.create({ data: { email: `queue-${role.toLowerCase()}-${tag}-${seq}@verify.aarogya`, passwordHash: "x", role, displayName: `Queue ${role} ${seq}` } });
  const s = await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId: dept.id, displayRole: role } });
  await ensurePrimaryMembership(prisma, user.id, facilityId, { isAdmin: role === "HOSPITAL_ADMIN" });
  return { userId: user.id, staffId: s.id, facilityId };
}

async function main() {
  const now = new Date();
  const at = (m: number) => new Date(now.getTime() + m * M);
  const admin = await staff(PUNE, "HOSPITAL_ADMIN");
  const [nurse, charge, incoming, other] = [await staff(PUNE, "NURSE"), await staff(PUNE, "NURSE"), await staff(PUNE, "NURSE"), await staff(PUNE, "NURSE")];
  const doctor = await staff(PUNE, "DOCTOR");
  const pharmacist = await staff(PUNE, "PHARMACIST");
  const noidaNurse = await staff(NOIDA, "NURSE");
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId: PUNE }, select: { id: true } });
  const ward = await prisma.ward.create({ data: { facilityId: PUNE, name: `Queue ward ${tag}`, wardType: "GENERAL", departmentId: dept.id } });
  await assignChargeShift(admin, ward.id, { staffId: charge.staffId, startAt: at(-120).toISOString(), endAt: at(180).toISOString() }, { now });
  await assignChargeShift(admin, ward.id, { staffId: incoming.staffId, startAt: at(180).toISOString(), endAt: at(600).toISOString() }, { now });
  const bed = await prisma.bed.create({ data: { wardId: ward.id, facilityId: PUNE, label: `Q-${tag}` } });
  const p = await prisma.patient.create({ data: { uhid: `Q-${tag}`, facilityId: PUNE, fullName: `Queue Patient ${tag}`, sex: "F" } });
  const enc = await prisma.encounter.create({ data: { patientId: p.id, facilityId: PUNE, type: "IPD", status: "ADMITTED" } });
  await prisma.nursingAssignment.create({ data: { facilityId: PUNE, nurseStaffId: nurse.staffId, patientId: p.id, encounterId: enc.id, bedId: bed.id, assignedByStaffId: admin.staffId } });
  const other2 = await prisma.patient.create({ data: { uhid: `Q2-${tag}`, facilityId: PUNE, fullName: `Queue Other ${tag}`, sex: "M" } });
  const enc2 = await prisma.encounter.create({ data: { patientId: other2.id, facilityId: PUNE, type: "IPD", status: "ADMITTED" } });
  const order = await prisma.medicationOrder.create({ data: { encounterId: enc.id, patientId: p.id, drugName: "Paracetamol", dose: "1 g", route: "ORAL", frequency: "QDS", orderedByStaffId: doctor.staffId, status: "ACTIVE" } });
  const dose = await prisma.medicationAdministration.create({ data: { medicationOrderId: order.id, scheduledAt: at(30), status: "DUE" } });
  const dev = await registerWardDevice(admin, { wardId: ward.id, label: `Queue tablet ${tag}` });
  const N = { userId: nurse.userId, staffId: nurse.staffId, facilityId: PUNE };
  const C = { userId: charge.userId, staffId: charge.staffId, facilityId: PUNE };
  const I = { userId: incoming.userId, staffId: incoming.staffId, facilityId: PUNE };
  const O = { userId: other.userId, staffId: other.staffId, facilityId: PUNE };

  // A possible double dose (taken over, given online, then given offline), and a refused record.
  await issuePack(N, { deviceId: dev.id }, { now });
  await overrideLease(C, { administrationId: dose.id, reason: `Tablet out of charge ${tag}` }, { now: at(20) });
  await administerMedication({ administrationId: dose.id, status: "GIVEN", administeredByStaffId: charge.staffId, byUserId: charge.userId });
  const syncAt = at(40);
  await syncCommands(N, { deviceId: dev.id, commands: [
    { clientOperationId: `q-${tag}-1`, kind: "DOSE_GIVEN", administrationId: dose.id, deviceTime: at(25).toISOString() },
    { clientOperationId: `q-${tag}-2`, kind: "VITALS", encounterId: enc2.id, vitals: { hr: 88 }, deviceTime: at(26).toISOString() },
  ] }, { now: syncAt });

  // 1. The queue.
  const q = await conflictQueue(C, { now: at(41) });
  const kinds = q.conflicts.map((c) => c.kind);
  report("The charge nurse on now sees their ward's open conflicts, CRITICAL first", q.wardIds.includes(ward.id) && kinds[0] === "POSSIBLE_DOUBLE_DOSE" && kinds.includes("REFUSED_RECORD"), kinds.join(","));
  const dd = q.conflicts.find((c) => c.kind === "POSSIBLE_DOUBLE_DOSE")!;
  report("…with who, what and when (patient, drug, device, nurse, the response time)", dd.patient?.uhid === `Q-${tag}` && dd.drug === "Paracetamol 1 g" && dd.device === `Queue tablet ${tag}` && Boolean(dd.nurse) && dd.dueAt !== null && dd.overdue === false);
  report("…and the dose taken over from the device, until confirmed in person", q.overrides.length === 1 && q.overrides[0].reason === `Tablet out of charge ${tag}` && q.overrides[0].deviceSynced === true);
  const qo = await conflictQueue(O, { now: at(41) });
  report("Another nurse sees no queue", qo.wardIds.length === 0 && qo.conflicts.length === 0 && qo.overrides.length === 0);

  // 2. The 15-minute escalation.
  const raised = await prisma.offlineConflict.findUniqueOrThrow({ where: { id: dd.conflictId } });
  await escalateOfflineConflicts({ now: new Date(raised.createdAt.getTime() + 14 * M) });
  report("Not escalated before 15 minutes", (await prisma.offlineConflict.findUniqueOrThrow({ where: { id: raised.id } })).escalatedAt === null);
  await escalateOfflineConflicts({ now: new Date(raised.createdAt.getTime() + 16 * M) });
  const esc = await prisma.offlineConflict.findUniqueOrThrow({ where: { id: raised.id } });
  report("At 15 minutes unresolved: escalated", esc.escalatedAt !== null);
  report("…the pharmacists get a STAT task and a notification each", (await prisma.task.count({ where: { idempotencyKey: `offline-conflict-escalated:${raised.id}`, assignedRole: "PHARMACIST", priority: "STAT" } })) === 1
    && (await prisma.notification.count({ where: { sourceId: raised.id, recipientStaffId: pharmacist.staffId, priority: "CRITICAL" } })) === 1);
  report("…with its event", (await prisma.domainEventOutbox.count({ where: { eventType: "OfflineConflictEscalated", aggregateId: raised.id } })) === 1);
  await escalateOfflineConflicts({ now: new Date(raised.createdAt.getTime() + 30 * M) });
  report("…once", (await prisma.domainEventOutbox.count({ where: { eventType: "OfflineConflictEscalated", aggregateId: raised.id } })) === 1 && (await prisma.notification.count({ where: { sourceId: raised.id } })) >= 1);
  report("A WARNING conflict is never escalated", (await prisma.offlineConflict.findFirstOrThrow({ where: { kind: "REFUSED_RECORD", command: { clientOperationId: `q-${tag}-2` } } })).escalatedAt === null);

  // 3. Resolving.
  const resolve = (who: typeof C, body: Record<string, unknown>, when = at(60)) => resolveConflict(who, raised.id, body, { now: when });
  report("Only the charge nurse on now may resolve", await refusedWith(resolve(O, { resolution: "NO_HARM_FOUND", reason: "x" }), "NotChargeNurseError"));
  report("…with a known resolution", await refusedWith(resolve(C, { resolution: "IGNORED", reason: "x" }), "BadRequestError"));
  report("…and a reason", await refusedWith(resolve(C, { resolution: "NO_HARM_FOUND", reason: " " }), "BadRequestError"));
  report("Another facility's nurse gets a 404", await refusedWith(resolveConflict({ userId: noidaNurse.userId, staffId: noidaNurse.staffId, facilityId: NOIDA }, raised.id, { resolution: "NO_HARM_FOUND", reason: "x" }), "NotFoundError"));
  const done = await resolve(C, { resolution: "INCIDENT_RAISED", reason: `Two doses given; doctor informed; incident filed ${tag}` });
  const task = await prisma.task.findUniqueOrThrow({ where: { id: raised.taskId! } });
  report("Resolved: recorded with who, when and how; the conflict's task completed", done.status === "RESOLVED" && done.resolution === "INCIDENT_RAISED" && done.resolvedByUserId === charge.userId && task.status === "COMPLETED");
  const audit = await prisma.auditEvent.findFirst({ where: { type: "hospital.offline.conflict.resolved", userId: charge.userId }, orderBy: { createdAt: "desc" } });
  report("…audited with the reason, and with its event", JSON.stringify(audit?.detail ?? {}).includes(`incident filed ${tag}`) && (await prisma.domainEventOutbox.count({ where: { eventType: "OfflineConflictResolved", aggregateId: raised.id } })) === 1);
  report("…never twice", await refusedWith(resolve(C, { resolution: "NO_HARM_FOUND", reason: "again" }), "ConflictError"));

  // 4. Confirming the takeover in person.
  const leaseId = q.overrides[0].leaseId;
  report("Confirming a takeover needs a reason", await refusedWith(confirmOverride(C, leaseId, { reason: "" }, { now: at(61) }), "BadRequestError"));
  report("…and the charge nurse on now", await refusedWith(confirmOverride(O, leaseId, { reason: "seen" }, { now: at(61) }), "NotChargeNurseError"));
  await confirmOverride(C, leaseId, { reason: `Checked with the nurse at the bedside ${tag}` }, { now: at(61) });
  report("Confirmed in person: audited, with its event, and off the queue",
    (await prisma.auditEvent.count({ where: { type: "hospital.offline.lease.override.confirmed", userId: charge.userId } })) === 1
    && (await prisma.domainEventOutbox.count({ where: { eventType: "DoseLeaseOverrideConfirmed", aggregateId: leaseId } })) === 1
    && (await conflictQueue(C, { now: at(62) })).overrides.length === 0);
  report("…never twice", await refusedWith(confirmOverride(C, leaseId, { reason: "again" }, { now: at(62) }), "ConflictError"));

  // 5. Handover.
  const after = await conflictQueue(I, { now: at(200) });
  report("After the handover the queue is the incoming charge nurse's (the open items stay)", after.wardIds.includes(ward.id) && after.conflicts.some((c) => c.kind === "REFUSED_RECORD") && !after.conflicts.some((c) => c.conflictId === raised.id));
  report("…and no longer the outgoing one's", (await conflictQueue(C, { now: at(200) })).wardIds.length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
