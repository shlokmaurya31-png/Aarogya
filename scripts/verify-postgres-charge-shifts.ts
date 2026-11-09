/**
 * Flagship 3a — the charge nurse per shift (docs/OFFLINE_NURSING_DESIGN.md §12.9).
 *
 *   1. The roster: the hospital admin names a charge nurse per ward per shift;
 *      back-to-back shifts are fine, overlapping ones are refused (also under
 *      a race: the exclusion constraint), and so are a shift already over, a
 *      non-nurse, and another facility's admin or ward (404). Each change has
 *      its event.
 *   2. Who is the charge nurse now: the shift's, else the ward's named one.
 *   3. Handover mid-lease: device A's leases span the handover. Before it,
 *      only the outgoing shift's charge nurse may take a dose over, and an
 *      offline conflict's task goes to them; after it, only the incoming
 *      shift's, and a possible double dose found then goes to them (with the
 *      shift named in the takeover's audit row).
 *   4. A cancelled shift: the ward's named charge nurse covers that time, and
 *      may take over.
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { ensurePrimaryMembership } from "../prisma/seedData/staffMembership";
import { administerMedication } from "../src/lib/hospital/medicationLifecycle";
import { designateChargeNurse, issuePack, NotChargeNurseError, overrideLease, registerWardDevice, syncCommands } from "../src/lib/hospital/offline/service";
import { assignChargeShift, cancelChargeShift, currentChargeNurse, listChargeShifts } from "../src/lib/hospital/offline/chargeShift";
import { tag } from "./lib/shareFixture";
import { enableOfflineForGate } from "./lib/offlineFixture";

const PUNE = "fac-amc-pune";
const NOIDA = "fac-amc-noida";
const H = 3_600_000;
let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const refusedWith = <T>(p: Promise<T>, name: string) => p.then(() => false, (e) => (e as Error).constructor.name === name);
let seq = 0;

async function staff(facilityId: string, role: "NURSE" | "DOCTOR" | "HOSPITAL_ADMIN") {
  seq += 1;
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId }, select: { id: true } });
  const user = await prisma.user.create({ data: { email: `shift-${role.toLowerCase()}-${tag}-${seq}@verify.aarogya`, passwordHash: "x", role, displayName: `Shift ${role} ${seq}` } });
  const s = await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId: dept.id, displayRole: role } });
  await ensurePrimaryMembership(prisma, user.id, facilityId, { isAdmin: role === "HOSPITAL_ADMIN" });
  return { userId: user.id, staffId: s.id, facilityId };
}

async function main() {
  const now = new Date();
  const at = (h: number) => new Date(now.getTime() + h * H);
  const admin = await staff(PUNE, "HOSPITAL_ADMIN");
  const noidaAdmin = await staff(NOIDA, "HOSPITAL_ADMIN");
  const [nurseA, outgoing, incoming, named, spare] = [await staff(PUNE, "NURSE"), await staff(PUNE, "NURSE"), await staff(PUNE, "NURSE"), await staff(PUNE, "NURSE"), await staff(PUNE, "NURSE")];
  const doctor = await staff(PUNE, "DOCTOR");
  const noidaNurse = await staff(NOIDA, "NURSE");
  // A ward of its own, so no other gate's roster is in the way.
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId: PUNE }, select: { id: true } });
  const ward = await prisma.ward.create({ data: { facilityId: PUNE, name: `Shift ward ${tag}`, wardType: "GENERAL", departmentId: dept.id } });
  const bed = await prisma.bed.create({ data: { wardId: ward.id, facilityId: PUNE, label: `SH-${tag}` } });
  await designateChargeNurse(admin, ward.id, { staffId: named.staffId });

  // 1. The roster.
  const events = () => prisma.domainEventOutbox.count({ where: { facilityId: PUNE, eventType: { in: ["WardChargeShiftAssigned", "WardChargeShiftCancelled"] }, payload: { path: ["wardId"], equals: ward.id } } });
  const shiftOut = await assignChargeShift(admin, ward.id, { staffId: outgoing.staffId, startAt: at(-5).toISOString(), endAt: at(1).toISOString() }, { now });
  const shiftIn = await assignChargeShift(admin, ward.id, { staffId: incoming.staffId, startAt: at(1).toISOString(), endAt: at(7).toISOString() }, { now });
  report("Back-to-back shifts are rostered (the outgoing ends as the incoming starts)", shiftOut.status === "ACTIVE" && shiftIn.status === "ACTIVE");
  report("…each with its event", (await events()) === 2);
  report("An overlapping shift is refused", await refusedWith(assignChargeShift(admin, ward.id, { staffId: spare.staffId, startAt: at(6).toISOString(), endAt: at(9).toISOString() }, { now }), "ConflictError"));
  const race = await Promise.allSettled([at(8), at(9)].map((s) => assignChargeShift(admin, ward.id, { staffId: spare.staffId, startAt: s.toISOString(), endAt: at(12).toISOString() }, { now })));
  report("Two overlapping shifts at the same moment: exactly one is rostered", race.filter((r) => r.status === "fulfilled").length === 1, race.map((r) => r.status).join(", "));
  const raced = race.find((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof assignChargeShift>>> => r.status === "fulfilled")!.value;
  report("A shift already over is refused", await refusedWith(assignChargeShift(admin, ward.id, { staffId: spare.staffId, startAt: at(-30).toISOString(), endAt: at(-24).toISOString() }, { now }), "BadRequestError"));
  report("A shift longer than 24 hours is refused", await refusedWith(assignChargeShift(admin, ward.id, { staffId: spare.staffId, startAt: at(30).toISOString(), endAt: at(56).toISOString() }, { now }), "BadRequestError"));
  report("A doctor can't be the charge nurse", await refusedWith(assignChargeShift(admin, ward.id, { staffId: doctor.staffId, startAt: at(30).toISOString(), endAt: at(36).toISOString() }, { now }), "NotFoundError"));
  report("Another facility's nurse can't be rostered here", await refusedWith(assignChargeShift(admin, ward.id, { staffId: noidaNurse.staffId, startAt: at(30).toISOString(), endAt: at(36).toISOString() }, { now }), "NotFoundError"));
  report("Another facility's admin can't roster this ward (404)", await refusedWith(assignChargeShift(noidaAdmin, ward.id, { staffId: noidaNurse.staffId, startAt: at(30).toISOString(), endAt: at(36).toISOString() }, { now }), "NotFoundError"));
  report("…or cancel its shift (404)", await refusedWith(cancelChargeShift(noidaAdmin, shiftIn.id), "NotFoundError"));
  report("…or read its roster (404)", await refusedWith(listChargeShifts(NOIDA, ward.id), "NotFoundError"));
  await cancelChargeShift(admin, raced.id);
  report("The roster lists the shifts not yet ended", JSON.stringify((await listChargeShifts(PUNE, ward.id, { from: now })).map((s) => s.id)) === JSON.stringify([shiftOut.id, shiftIn.id]));

  // 2. Who is on now.
  const c0 = await currentChargeNurse(prisma, ward.id, now);
  const c1 = await currentChargeNurse(prisma, ward.id, at(1));
  const c8 = await currentChargeNurse(prisma, ward.id, at(8));
  report("Now: the outgoing shift's charge nurse", c0.staffId === outgoing.staffId && c0.source === "SHIFT");
  report("From the handover (half-open): the incoming shift's", c1.staffId === incoming.staffId && c1.source === "SHIFT");
  report("With no shift on: the ward's named charge nurse", c8.staffId === named.staffId && c8.source === "WARD");

  // 3. Handover mid-lease.
  const patient = await prisma.patient.create({ data: { uhid: `SHF-${tag}`, facilityId: PUNE, fullName: `Shift Patient ${tag}`, sex: "M" } });
  const enc = await prisma.encounter.create({ data: { patientId: patient.id, facilityId: PUNE, type: "IPD", status: "ADMITTED" } });
  await prisma.nursingAssignment.create({ data: { facilityId: PUNE, nurseStaffId: nurseA.staffId, patientId: patient.id, encounterId: enc.id, bedId: bed.id, assignedByStaffId: admin.staffId } });
  const order = (drugName: string, isControlled = false) => prisma.medicationOrder.create({ data: { encounterId: enc.id, patientId: patient.id, drugName, dose: "1 tab", route: "ORAL", frequency: "TDS", orderedByStaffId: doctor.staffId, status: "ACTIVE", isControlled } });
  const para = await order("Paracetamol");
  const morphine = await order("Morphine", true);
  const dose = (orderId: string, h: number) => prisma.medicationAdministration.create({ data: { medicationOrderId: orderId, scheduledAt: at(h), status: "DUE" } });
  const d1 = await dose(para.id, 2);
  const d2 = await dose(para.id, 3);
  const dc = await dose(morphine.id, 0.5);
  // Flagship 4e: the ward's offline mode on (with the sign-off) before any pack.
  await enableOfflineForGate(admin, ward.id);
  const dev = await registerWardDevice(admin, { wardId: ward.id, label: `Shift tablet ${tag}` });
  const A = { userId: nurseA.userId, staffId: nurseA.staffId, facilityId: PUNE };
  const pack = await issuePack(A, { deviceId: dev.id }, { now });
  report("Device A's leases span the handover", new Date(pack.expiresAt) > at(1) && pack.patients.flatMap((p) => p.doses).filter((d) => d.givableOffline).length === 2, pack.expiresAt);
  const O = { userId: outgoing.userId, staffId: outgoing.staffId, facilityId: PUNE };
  const I = { userId: incoming.userId, staffId: incoming.staffId, facilityId: PUNE };
  const W = { userId: named.userId, staffId: named.staffId, facilityId: PUNE };

  report("Before the handover the incoming charge nurse can't take a dose over", await refusedWith(overrideLease(I, { administrationId: d1.id, reason: "early" }, { now: at(0.5) }), NotChargeNurseError.name));
  report("…nor the ward's named one (a shift is on)", await refusedWith(overrideLease(W, { administrationId: d1.id, reason: "named" }, { now: at(0.5) }), NotChargeNurseError.name));
  const sBefore = await syncCommands(A, { deviceId: dev.id, commands: [{ clientOperationId: `shift-${tag}-1`, kind: "DOSE_GIVEN", administrationId: dc.id, deviceTime: at(0.4).toISOString() }] }, { now: at(0.5) });
  const cBefore = await prisma.offlineConflict.findFirstOrThrow({ where: { administrationId: dc.id } });
  const tBefore = await prisma.task.findUniqueOrThrow({ where: { id: cBefore.taskId! } });
  report("A conflict before the handover goes to the outgoing charge nurse", sBefore.results[0].outcome === "REFUSED" && tBefore.ownerStaffId === outgoing.staffId);

  report("After the handover the outgoing charge nurse can't take a dose over", await refusedWith(overrideLease(O, { administrationId: d1.id, reason: "late" }, { now: at(1.5) }), NotChargeNurseError.name));
  const ov = await overrideLease(I, { administrationId: d1.id, reason: `Tablet left in the sluice ${tag}` }, { now: at(1.5) });
  const audit = await prisma.auditEvent.findFirst({ where: { type: "hospital.offline.lease.overridden", userId: incoming.userId }, orderBy: { createdAt: "desc" } });
  const detail = (audit?.detail ?? {}) as Record<string, unknown>;
  report("…the incoming one can, and the audit row names the shift", ov.status === "OVERRIDDEN" && detail.shiftId === shiftIn.id && detail.chargeNurseSource === "SHIFT");
  await administerMedication({ administrationId: d1.id, status: "GIVEN", administeredByStaffId: incoming.staffId, byUserId: incoming.userId });
  const sAfter = await syncCommands(A, { deviceId: dev.id, commands: [{ clientOperationId: `shift-${tag}-2`, kind: "DOSE_GIVEN", administrationId: d1.id, deviceTime: at(1.4).toISOString() }] }, { now: at(2) });
  const cAfter = await prisma.offlineConflict.findFirstOrThrow({ where: { administrationId: d1.id, kind: "POSSIBLE_DOUBLE_DOSE" } });
  const tAfter = await prisma.task.findUniqueOrThrow({ where: { id: cAfter.taskId! } });
  report("A possible double dose found after the handover goes to the incoming charge nurse", sAfter.results[0].conflicts.some((c) => c.kind === "POSSIBLE_DOUBLE_DOSE") && tAfter.ownerStaffId === incoming.staffId && tAfter.priority === "STAT");

  // 4. A cancelled shift: the ward's named charge nurse covers it.
  await cancelChargeShift(admin, shiftIn.id);
  report("Cancelling a shift has its event", (await events()) === 5, `${await events()} events`);
  const cNow = await currentChargeNurse(prisma, ward.id, at(2.5));
  report("With the shift cancelled, the ward's named charge nurse is on", cNow.staffId === named.staffId && cNow.source === "WARD");
  report("…the cancelled shift's nurse can no longer take over", await refusedWith(overrideLease(I, { administrationId: d2.id, reason: "cancelled" }, { now: at(2.5) }), NotChargeNurseError.name));
  const ovW = await overrideLease(W, { administrationId: d2.id, reason: `Covering ${tag}` }, { now: at(2.5) });
  report("…and the named one can", ovW.status === "OVERRIDDEN");

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
