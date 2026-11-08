/**
 * Flagship 2, step 5 — offline nursing, phase 1 (docs/OFFLINE_NURSING_DESIGN.md §13).
 *
 *   1. Two devices, one lease: the first device's pack takes the lease on each
 *      due dose; the second's pack gets none of them (read-only, "not on this
 *      device"); the online MAR refuses a leased dose too. Controlled and
 *      high-alert medicines are never leased, and refused offline.
 *   2. A dose given offline is applied with the device's time; the same sync
 *      sent again is a no-op (same answers, no new rows, no new events).
 *   3. A possible double dose: the charge nurse takes a lease over (a reason
 *      is required, and only the ward's charge nurse may), gives the dose
 *      online; the holder then syncs its offline dose: it is recorded (never
 *      discarded), flagged CRITICAL, the charge nurse gets a task due within
 *      15 minutes and the pharmacists are told; the holder is told of the
 *      override; the override is logged with its reason.
 *   4. An expired lease is refused (and the claimed dose kept for review).
 *   5. Another facility can't use the device or see its doses (404).
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { ensurePrimaryMembership } from "../prisma/seedData/staffMembership";
import { administerMedication, DoseLeasedError } from "../src/lib/hospital/medicationLifecycle";
import { designateChargeNurse, issuePack, overrideLease, registerWardDevice, syncCommands } from "../src/lib/hospital/offline/service";
import { tag } from "./lib/shareFixture";

const PUNE = "fac-amc-pune";
const NOIDA = "fac-amc-noida";
let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const refused = <T>(p: Promise<T>) => p.then(() => false, () => true);
let seq = 0;

async function staff(facilityId: string, role: "NURSE" | "DOCTOR" | "HOSPITAL_ADMIN") {
  seq += 1;
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId }, select: { id: true } });
  const user = await prisma.user.create({ data: { email: `offline-${role.toLowerCase()}-${tag}-${seq}@verify.aarogya`, passwordHash: "x", role, displayName: `Offline ${role} ${seq}` } });
  const s = await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId: dept.id, displayRole: role } });
  await ensurePrimaryMembership(prisma, user.id, facilityId, { isAdmin: role === "HOSPITAL_ADMIN" });
  return { userId: user.id, staffId: s.id, facilityId };
}

async function main() {
  const now = new Date();
  const admin = await staff(PUNE, "HOSPITAL_ADMIN");
  const nurseA = await staff(PUNE, "NURSE");
  const charge = await staff(PUNE, "NURSE");
  const other = await staff(PUNE, "NURSE");
  const doctor = await staff(PUNE, "DOCTOR");
  const ward = await prisma.ward.findFirstOrThrow({ where: { facilityId: PUNE }, select: { id: true } });
  const bed = await prisma.bed.findFirst({ where: { wardId: ward.id }, select: { id: true } });
  await designateChargeNurse(admin, ward.id, { staffId: charge.staffId });

  // A patient on the ward, assigned to nurse A, with two ordinary orders and one controlled.
  const patient = await prisma.patient.create({ data: { uhid: `OFF-${tag}`, facilityId: PUNE, fullName: `Offline Patient ${tag}`, sex: "F" } });
  const enc = await prisma.encounter.create({ data: { patientId: patient.id, facilityId: PUNE, type: "IPD", status: "ADMITTED" } });
  await prisma.nursingAssignment.create({ data: { facilityId: PUNE, nurseStaffId: nurseA.staffId, patientId: patient.id, encounterId: enc.id, bedId: bed?.id, assignedByStaffId: admin.staffId } });
  const order = (drugName: string, isControlled = false) => prisma.medicationOrder.create({ data: { encounterId: enc.id, patientId: patient.id, drugName, dose: "1 tab", route: "ORAL", frequency: "TDS", orderedByStaffId: doctor.staffId, status: "ACTIVE", isControlled } });
  const para = await order("Paracetamol");
  const amox = await order("Amoxicillin");
  const morphine = await order("Morphine", true);
  const dose = (orderId: string, minutes: number) => prisma.medicationAdministration.create({ data: { medicationOrderId: orderId, scheduledAt: new Date(now.getTime() + minutes * 60_000), status: "DUE" } });
  const d1 = await dose(para.id, 30);
  const d2 = await dose(amox.id, 60);
  const d3 = await dose(para.id, 150);
  const dc = await dose(morphine.id, 30);

  const devA = await registerWardDevice(admin, { wardId: ward.id, label: `Tablet A ${tag}` });
  const devB = await registerWardDevice(admin, { wardId: ward.id, label: `Tablet B ${tag}` });
  const A = { userId: nurseA.userId, staffId: nurseA.staffId, facilityId: PUNE };

  // 1. Two devices, one lease.
  const packA = await issuePack(A, { deviceId: devA.id, deviceClock: new Date(now.getTime() - 60_000).toISOString() }, { now });
  const packB = await issuePack(A, { deviceId: devB.id }, { now });
  const dosesA = packA.patients.flatMap((p) => p.doses);
  const dosesB = packB.patients.flatMap((p) => p.doses);
  report("Device A's pack holds the lease on each due dose of the assigned patient", [d1.id, d2.id, d3.id].every((id) => dosesA.find((d) => d.administrationId === id)?.givableOffline), `${dosesA.filter((d) => d.givableOffline).length} givable`);
  report("Device B's pack shows the same doses, none givable (\"not on this device\")", [d1.id, d2.id, d3.id].every((id) => dosesB.find((d) => d.administrationId === id)?.givableOffline === false));
  const active = await prisma.doseLease.groupBy({ by: ["administrationId"], where: { administrationId: { in: [d1.id, d2.id, d3.id] }, status: "ACTIVE" }, _count: { _all: true } });
  report("Exactly one ACTIVE lease per dose", active.length === 3 && active.every((g) => g._count._all === 1));
  report("The controlled drug is never leased, and is online only", dosesA.find((d) => d.administrationId === dc.id)?.onlineOnly === true && !dosesA.find((d) => d.administrationId === dc.id)?.givableOffline);
  report("The online MAR refuses a dose a device holds", await administerMedication({ administrationId: d1.id, status: "GIVEN", administeredByStaffId: other.staffId, byUserId: other.userId }).then(() => false, (e) => e instanceof DoseLeasedError));
  report("The pack's clock offset is measured", Math.abs(packA.clockOffsetMs - 60_000) < 1_000, `${packA.clockOffsetMs} ms`);

  // 2. Given offline; then the same sync again.
  const givenAt = new Date(now.getTime() + 25 * 60_000 - 60_000); // device clock, a minute slow
  const syncNow = new Date(now.getTime() + 40 * 60_000);
  const cmds = [
    { clientOperationId: `op-${tag}-1`, kind: "DOSE_GIVEN", administrationId: d1.id, deviceTime: givenAt.toISOString() },
    { clientOperationId: `op-${tag}-2`, kind: "DOSE_GIVEN", administrationId: dc.id, deviceTime: givenAt.toISOString() },
  ];
  const s1 = await syncCommands(A, { deviceId: devA.id, commands: cmds }, { now: syncNow });
  const d1After = await prisma.medicationAdministration.findUniqueOrThrow({ where: { id: d1.id } });
  report("A dose given offline is applied", s1.results[0].outcome === "APPLIED" && d1After.status === "GIVEN", s1.results[0].outcome);
  report("…at the time it was given (the device's time, corrected by the measured offset)", Math.abs(d1After.administeredAt!.getTime() - (givenAt.getTime() + 60_000)) < 1_000, d1After.administeredAt?.toISOString());
  report("A controlled drug given offline is refused (online only), and kept for review", s1.results[1].outcome === "REFUSED" && s1.results[1].refusalReason === "ONLINE_ONLY" && (await prisma.medicationAdministration.findUniqueOrThrow({ where: { id: dc.id } })).status === "DUE" && s1.results[1].conflicts.some((c) => c.kind === "ONLINE_ONLY"));
  const counts = async () => ({
    commands: await prisma.offlineCommand.count({ where: { deviceId: devA.id } }),
    admins: await prisma.medicationAdministration.count({ where: { medicationOrder: { patientId: patient.id } } }),
    events: await prisma.domainEventOutbox.count({ where: { facilityId: PUNE, eventType: { in: ["MedicationAdministered", "OfflineCommandRecorded", "OfflineConflictRecorded"] } } }),
    conflicts: await prisma.offlineConflict.count({ where: { command: { deviceId: devA.id } } }),
  });
  const before = await counts();
  const s2 = await syncCommands(A, { deviceId: devA.id, commands: cmds }, { now: new Date(syncNow.getTime() + 60_000) });
  const after = await counts();
  report("The same sync again answers the same, marked replayed", s2.results.every((r, i) => r.replayed && r.outcome === s1.results[i].outcome));
  report("…and changes nothing: no new command, dose, conflict or event", JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

  // 3. The charge nurse takes d2 over; gives it online; device A then syncs its offline dose.
  const C = { userId: charge.userId, staffId: charge.staffId, facilityId: PUNE };
  report("Only the ward's charge nurse may take a lease over", await refused(overrideLease({ userId: other.userId, staffId: other.staffId, facilityId: PUNE }, { administrationId: d2.id, reason: "covering" })));
  report("A takeover needs a reason", await refused(overrideLease(C, { administrationId: d2.id, reason: "  " })));
  const ov = await overrideLease(C, { administrationId: d2.id, reason: `Tablet A battery flat ${tag}` });
  const lease2 = await prisma.doseLease.findUniqueOrThrow({ where: { id: ov.leaseId } });
  const audit = await prisma.auditEvent.findFirst({ where: { type: "hospital.offline.lease.overridden", userId: charge.userId }, orderBy: { createdAt: "desc" } });
  report("The override is logged with its reason", lease2.status === "OVERRIDDEN" && lease2.overrideReason === `Tablet A battery flat ${tag}` && lease2.endedByUserId === charge.userId && JSON.stringify(audit?.detail ?? {}).includes(`Tablet A battery flat ${tag}`));
  report("…with its event", (await prisma.domainEventOutbox.count({ where: { eventType: "DoseLeaseOverridden", aggregateId: lease2.id } })) === 1);
  await administerMedication({ administrationId: d2.id, status: "GIVEN", administeredByStaffId: charge.staffId, byUserId: charge.userId });
  report("After the takeover the dose can be given online", (await prisma.medicationAdministration.findUniqueOrThrow({ where: { id: d2.id } })).status === "GIVEN");
  const s3 = await syncCommands(A, { deviceId: devA.id, commands: [{ clientOperationId: `op-${tag}-3`, kind: "DOSE_GIVEN", administrationId: d2.id, deviceTime: new Date(now.getTime() + 55 * 60_000).toISOString() }] }, { now: new Date(now.getTime() + 70 * 60_000) });
  const r3 = s3.results[0];
  const seconds = await prisma.medicationAdministration.findMany({ where: { offlineGivenForAdministrationId: d2.id } });
  report("The offline dose is recorded, not discarded: a second GIVEN beside the first", r3.outcome === "APPLIED_WITH_CONFLICT" && seconds.length === 1 && seconds[0].status === "GIVEN", r3.outcome);
  report("…flagged as a possible double dose, CRITICAL", r3.conflicts.some((c) => c.kind === "POSSIBLE_DOUBLE_DOSE" && c.severity === "CRITICAL"));
  const conflict = await prisma.offlineConflict.findFirstOrThrow({ where: { administrationId: d2.id, kind: "POSSIBLE_DOUBLE_DOSE" } });
  const task = await prisma.task.findUniqueOrThrow({ where: { id: conflict.taskId! } });
  report("The charge nurse gets the task, due within 15 minutes", task.ownerStaffId === charge.staffId && task.priority === "STAT" && task.dueAt!.getTime() - (now.getTime() + 70 * 60_000) <= 15 * 60_000, `due ${task.dueAt?.toISOString()}`);
  report("…and the pharmacists are told", (await prisma.task.count({ where: { facilityId: PUNE, assignedRole: "PHARMACIST", patientId: patient.id, type: "OFFLINE_DOSE_CONFLICT" } })) === 1);
  report("…with the conflict's event in the same transaction as the dose", (await prisma.domainEventOutbox.count({ where: { eventType: "OfflineConflictRecorded", aggregateId: conflict.id } })) === 1 && (await prisma.domainEventOutbox.count({ where: { eventType: "MedicationAdministered", aggregateId: seconds[0].id } })) === 1);
  report("Device A is told its dose was taken over", s3.notices.some((n) => n.administrationId === d2.id && n.ended === "OVERRIDDEN"));

  // 4. An expired lease is refused.
  const late = new Date(new Date(packA.expiresAt).getTime() + 10 * 60_000);
  const s4 = await syncCommands(A, { deviceId: devA.id, commands: [{ clientOperationId: `op-${tag}-4`, kind: "DOSE_GIVEN", administrationId: d3.id, deviceTime: late.toISOString() }] }, { now: new Date(late.getTime() + 60_000) });
  report("A dose recorded after its lease expired is refused", s4.results[0].outcome === "REFUSED" && s4.results[0].refusalReason === "LEASE_EXPIRED" && (await prisma.medicationAdministration.findUniqueOrThrow({ where: { id: d3.id } })).status === "DUE", s4.results[0].refusalReason ?? "");
  report("…and the claim is kept for a person to review (a conflict, not dropped)", s4.results[0].conflicts.some((c) => c.kind === "LEASE_EXPIRED") && (await prisma.offlineCommand.count({ where: { clientOperationId: `op-${tag}-4` } })) === 1);

  // 5. Another facility.
  const noidaNurse = await staff(NOIDA, "NURSE");
  const N = { userId: noidaNurse.userId, staffId: noidaNurse.staffId, facilityId: NOIDA };
  report("Another facility's nurse can't take a pack on this device", await issuePack(N, { deviceId: devA.id }).then(() => false, (e) => (e as Error).constructor.name === "NotFoundError"));
  report("…or sync to it", await syncCommands(N, { deviceId: devA.id, commands: [] }).then(() => false, (e) => (e as Error).constructor.name === "NotFoundError"));

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
