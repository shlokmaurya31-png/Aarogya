/**
 * Flagship 3b — changing a facility's time zone (pre-launch item 25, decided
 * 2026-11-08).
 *
 *   1. Who: only the hospital admin may ask (in writing), and only platform
 *      staff (AAROGYA_ADMIN) may decide (permission table).
 *   2. The request: an IANA zone that differs from the current one, and a
 *      written request; one open request per facility; audited, with its event.
 *   3. Approval with future bookings: refused (409) unless confirmed, and
 *      then nothing changes (no zone, no event, no notification).
 *   4. Approval confirmed: the zone changes (from the zone it was requested
 *      against), the request and the change each have their event, the
 *      decision is audited, every future booking is notified (the patient in
 *      their language when linked, and always the booking's doctor), while past
 *      and cancelled bookings aren't; bookings keep their instants; the
 *      facility's clock now reads in the new zone.
 *   5. A rejection: a note required, audited, its event; the zone unchanged.
 *   6. Another facility's admin never sees the request.
 *
 * Runs on a facility of its own, so no other gate's clock moves.
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { ensurePrimaryMembership } from "../prisma/seedData/staffMembership";
import { roleHasPermission } from "../src/lib/auth/permissions";
import { decideTimeZoneChange, FutureAppointmentsError, listFacilityTimeZoneChanges, listOpenTimeZoneChanges, requestTimeZoneChange } from "../src/lib/hospital/facilityTimeZoneChange";
import { facilityTimeZone, zonedParts } from "../src/lib/time/zone";
import { tag } from "./lib/shareFixture";

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

async function main() {
  const now = new Date();
  const pune = await prisma.facility.findUniqueOrThrow({ where: { id: "fac-amc-pune" }, select: { organizationId: true } });
  const fac = await prisma.facility.create({ data: { name: `Zone change ${tag}`, organizationId: pune.organizationId } });
  const dept = await prisma.department.create({ data: { facilityId: fac.id, name: `OPD ${tag}` } });
  const staff = async (facilityId: string, departmentId: string, role: "HOSPITAL_ADMIN" | "DOCTOR" | "AAROGYA_ADMIN") => {
    seq += 1;
    const user = await prisma.user.create({ data: { email: `tz-${role.toLowerCase()}-${tag}-${seq}@verify.aarogya`, passwordHash: "x", role, displayName: `TZ ${role} ${seq}` } });
    if (role === "AAROGYA_ADMIN") return { userId: user.id, staffId: "", facilityId };
    const s = await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId, displayRole: role } });
    await ensurePrimaryMembership(prisma, user.id, facilityId, { isAdmin: role === "HOSPITAL_ADMIN" });
    return { userId: user.id, staffId: s.id, facilityId };
  };
  const admin = await staff(fac.id, dept.id, "HOSPITAL_ADMIN");
  const doctor = await staff(fac.id, dept.id, "DOCTOR");
  const platform = await staff(fac.id, dept.id, "AAROGYA_ADMIN");
  const noidaDept = await prisma.department.findFirstOrThrow({ where: { facilityId: NOIDA }, select: { id: true } });
  const noidaAdmin = await staff(NOIDA, noidaDept.id, "HOSPITAL_ADMIN");
  const A = { userId: admin.userId, facilityId: fac.id };
  const P = { userId: platform.userId };

  // 1. Who.
  report("The hospital admin may ask; a doctor or nurse may not", roleHasPermission("HOSPITAL_ADMIN", "facility:time-zone:request") && !roleHasPermission("DOCTOR", "facility:time-zone:request") && !roleHasPermission("NURSE", "facility:time-zone:request"));
  report("Only platform staff may decide (not a hospital admin)", roleHasPermission("AAROGYA_ADMIN", "platform:facility:time-zone") && !roleHasPermission("HOSPITAL_ADMIN", "platform:facility:time-zone"));

  // 2. The request.
  const ask = (timeZone: string, writtenRequest = `Our hospital moved to Dubai; asked by the medical director ${tag}`) => requestTimeZoneChange(A, { timeZone, writtenRequest });
  report("A zone that isn't IANA is refused", await refusedWith(ask("Mars/Olympus"), "BadRequestError"));
  report("The zone it already uses is refused", await refusedWith(ask("Asia/Kolkata"), "BadRequestError"));
  report("A request without a written reason is refused", await refusedWith(ask("Asia/Dubai", "please"), "BadRequestError"));
  const req1 = await ask("Asia/Dubai");
  report("A written request is recorded, from the current zone", req1.status === "REQUESTED" && req1.fromTimeZone === "Asia/Kolkata" && req1.toTimeZone === "Asia/Dubai");
  report("…with its event", (await prisma.domainEventOutbox.count({ where: { eventType: "FacilityTimeZoneChangeRequested", aggregateId: req1.id } })) === 1);
  const reqAudit = await prisma.auditEvent.findFirst({ where: { type: "hospital.facility.time-zone.requested", userId: admin.userId } });
  report("…and audited, with the written request", JSON.stringify(reqAudit?.detail ?? {}).includes(`medical director ${tag}`));
  report("A second open request is refused", await refusedWith(ask("Asia/Kathmandu"), "ConflictError"));
  report("Platform staff see it among the open requests", (await listOpenTimeZoneChanges(now)).some((r) => r.id === req1.id));
  report("Another facility's admin never sees it", !(await listFacilityTimeZoneChanges(noidaAdmin.facilityId)).some((r) => r.id === req1.id));

  // Bookings: two future (one patient linked to a Person who reads Hindi, one not), one past, one cancelled.
  const person = await prisma.person.create({ data: { displayName: `TZ Person ${tag}`, preferredLanguage: "hi", dataClassification: "SYNTHETIC" } });
  const patient = async (linked: boolean) => {
    seq += 1;
    const p = await prisma.patient.create({ data: { uhid: `TZ-${tag}-${seq}`, facilityId: fac.id, fullName: `TZ Patient ${seq}`, sex: "F" } });
    if (linked) await prisma.personPatientLink.create({ data: { personId: person.id, patientId: p.id, facilityId: fac.id, status: "ACTIVE", method: "SELF_CREATED", linkedAt: now, linkedByUserId: admin.userId } });
    return p;
  };
  const linked = await patient(true);
  const unlinked = await patient(false);
  const book = (patientId: string, h: number, status: "CONFIRMED" | "CANCELLED" | "COMPLETED" = "CONFIRMED") =>
    prisma.appointment.create({ data: { facilityId: fac.id, departmentId: dept.id, doctorStaffId: doctor.staffId, patientId, scheduledStart: new Date(now.getTime() + h * H), scheduledEnd: new Date(now.getTime() + h * H + 15 * 60_000), status, createdByStaffId: doctor.staffId } });
  const fLinked = await book(linked.id, 26);
  const fUnlinked = await book(unlinked.id, 50);
  const past = await book(linked.id, -30, "COMPLETED");
  const cancelled = await book(unlinked.id, 30, "CANCELLED");

  // 3. Approval without confirming the future bookings.
  const decide = (body: Record<string, unknown>) => decideTimeZoneChange(P, req1.id, body, { now });
  report("A decision needs a note", await refusedWith(decide({ decision: "APPROVE", confirmFutureAppointments: true }), "BadRequestError"));
  const unconfirmed = await decide({ decision: "APPROVE", note: "Checked with the hospital" }).then(() => null, (e) => e);
  report("Approval with future bookings is refused unless confirmed (409, with the count)", unconfirmed instanceof FutureAppointmentsError && unconfirmed.futureAppointments === 2, unconfirmed?.message);
  report("…and nothing changed: the zone, the request, no event, no notification",
    (await facilityTimeZone(prisma, fac.id)) === "Asia/Kolkata"
    && (await prisma.facilityTimeZoneChange.findUniqueOrThrow({ where: { id: req1.id } })).status === "REQUESTED"
    && (await prisma.domainEventOutbox.count({ where: { eventType: { in: ["FacilityTimeZoneChangeApproved", "FacilityTimeZoneChanged"] }, facilityId: fac.id } })) === 0
    && (await prisma.notification.count({ where: { sourceId: req1.id } })) === 0);

  // 4. Approval confirmed.
  const ok = await decide({ decision: "APPROVE", note: `Confirmed with the hospital ${tag}`, confirmFutureAppointments: true });
  report("Confirmed: approved, the zone changed", ok.request.status === "APPROVED" && ok.request.futureAppointments === 2 && ok.request.confirmedFutureAppointments && (await facilityTimeZone(prisma, fac.id)) === "Asia/Dubai");
  report("…the approval and the change each have their event",
    (await prisma.domainEventOutbox.count({ where: { eventType: "FacilityTimeZoneChangeApproved", aggregateId: req1.id } })) === 1
    && (await prisma.domainEventOutbox.count({ where: { eventType: "FacilityTimeZoneChanged", aggregateId: fac.id } })) === 1);
  const decAudit = await prisma.auditEvent.findFirst({ where: { type: "platform.facility.time-zone.approved", userId: platform.userId } });
  report("…and the decision is audited, with its note", JSON.stringify(decAudit?.detail ?? {}).includes(`Confirmed with the hospital ${tag}`));
  const notes = await prisma.personNotification.findMany({ where: { personId: person.id, kind: "APPOINTMENT_TIME_ZONE_CHANGED" } });
  report("The linked patient is told, in their language", notes.length === 1 && notes[0].language === "hi" && notes[0].dedupeKey.includes(fLinked.id), notes.map((n) => n.language).join(","));
  const docNotes = await prisma.notification.findMany({ where: { sourceType: "FacilityTimeZoneChange", sourceId: req1.id } });
  report("The doctor is told of every future booking, urgently for a patient the app can't reach",
    docNotes.length === 2 && docNotes.every((n) => n.recipientStaffId === doctor.staffId)
    && docNotes.find((n) => n.patientId === unlinked.id)?.priority === "URGENT" && docNotes.find((n) => n.patientId === linked.id)?.priority === "ROUTINE");
  report("Past and cancelled bookings aren't notified", docNotes.length === 2 && (await prisma.personNotification.count({ where: { dedupeKey: { contains: past.id } } })) === 0 && (await prisma.personNotification.count({ where: { dedupeKey: { contains: cancelled.id } } })) === 0);
  report("No booking moved", (await prisma.appointment.findUniqueOrThrow({ where: { id: fUnlinked.id } })).scheduledStart.getTime() === fUnlinked.scheduledStart.getTime());
  const reads = zonedParts(fLinked.scheduledStart, await facilityTimeZone(prisma, fac.id));
  const readsIst = zonedParts(fLinked.scheduledStart, "Asia/Kolkata");
  report("The facility's clock now reads the booking in the new zone (90 minutes behind India)", (readsIst.hour * 60 + readsIst.minute) - (reads.hour * 60 + reads.minute) === 90 || (readsIst.hour * 60 + readsIst.minute) - (reads.hour * 60 + reads.minute) === 90 - 1440, `${reads.hour}:${reads.minute} vs ${readsIst.hour}:${readsIst.minute}`);
  report("A decided request can't be decided again", await refusedWith(decide({ decision: "REJECT", note: "again" }), "ConflictError"));

  // 5. A rejection.
  const req2 = await requestTimeZoneChange(A, { timeZone: "Asia/Kolkata", writtenRequest: `We were wrong; back to India time, the director ${tag}` });
  const rej = await decideTimeZoneChange(P, req2.id, { decision: "REJECT", note: "Please confirm with the medical director in writing" }, { now });
  report("A rejection is recorded with its note and event, and the zone stays",
    rej.request.status === "REJECTED" && rej.request.decisionNote!.length > 0 && (await facilityTimeZone(prisma, fac.id)) === "Asia/Dubai"
    && (await prisma.domainEventOutbox.count({ where: { eventType: "FacilityTimeZoneChangeRejected", aggregateId: req2.id } })) === 1
    && (await prisma.auditEvent.count({ where: { type: "platform.facility.time-zone.rejected", userId: platform.userId } })) === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
