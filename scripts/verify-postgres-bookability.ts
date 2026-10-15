/**
 * D7: one source for leave and absence, and one bookability rule:
 * inside a DoctorScheduleBlock session AND not on leave (StaffAbsence) AND not
 * off shift (src/lib/hospital/bookability.ts).
 *
 * Tries to book a doctor who is on leave — from Hospital OS and from the
 * patient portal — and checks the slot list agrees with booking:
 *   1. A normal session slot books.
 *   2. Whole-day leave: no slots, and both booking paths are refused; nothing
 *      is created.
 *   3. Partial-day leave removes only those slots.
 *   4. Outside every session is refused.
 *   5. Rostered day: outside the shift is refused; a day whose only shift was
 *      cancelled has no slots.
 *   6. Leave entered through workforce availability (ON_LEAVE) blocks booking
 *      from both paths; AVAILABLE lifts it.
 *   7. There is one leave source: DoctorScheduleBlock has no type column and
 *      StaffAvailability is gone.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-bookability.ts
 */
import { prisma } from "../src/lib/db";
import { bookAppointment } from "../src/lib/hospital/appointment";
import { getAvailableSlots } from "../src/lib/hospital/doctorSchedule";
import { DoctorNotBookableError } from "../src/lib/hospital/bookability";
import { setAvailability } from "../src/lib/hospital/workforce/service";
import { isStaffAvailable } from "../src/lib/hospital/workforce/authorization";
import { requestAppointment } from "../src/lib/patient/experience/appointments";
import type { PatientAccessScope } from "../src/lib/patient/context";
import { ensurePrimaryMembership } from "../prisma/seedData/staffMembership";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const ALL = ["PERSONAL", "APPOINTMENTS", "QUEUE", "RECORDS", "REPORTS", "PRESCRIPTIONS", "MEDICATIONS", "BILLING", "INSURANCE", "CONSENT"] as const;

/** Local midnight `days` from today, plus hh:mm. */
function at(days: number, hh = 0, mm = 0): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  d.setHours(hh, mm, 0, 0);
  return d;
}
const hhmm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const admin = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { user: { email: "admin@amc-demo.aarogya" } } });
  const user = await prisma.user.create({ data: { email: `d7-doctor-${run}@verify.aarogya`, passwordHash: "x", role: "DOCTOR", displayName: `Dr D7 ${run}` } });
  const doctor = await prisma.hospitalStaffProfile.create({ data: { userId: user.id, displayRole: "Physician", status: "ACTIVE" } });
  await ensurePrimaryMembership(prisma, user.id, facilityId);
  for (let dow = 0; dow <= 6; dow++) {
    await prisma.doctorScheduleBlock.create({ data: { staffId: doctor.id, facilityId, dayOfWeek: dow, startMinute: 540, endMinute: 780, slotDurationMinutes: 15 } }); // 09:00–13:00
  }
  const patientUser = await prisma.user.create({ data: { email: `d7-patient-${run}@verify.aarogya`, passwordHash: "x", role: "PATIENT", displayName: "D7 patient" } });
  const patient = await prisma.patient.create({ data: { uhid: `D7-${run}`, facilityId, fullName: `D7 Patient ${run}`, sex: "F", userId: patientUser.id } });
  const scope: PatientAccessScope = { patientId: patient.id, patientIds: [patient.id], facilityId, isSelf: true, allowedClasses: new Set(ALL) };

  const book = (start: Date, minutes = 15) =>
    bookAppointment({ facilityId, doctorStaffId: doctor.id, patientId: patient.id, scheduledStart: start, scheduledEnd: new Date(start.getTime() + minutes * 60_000), createdByStaffId: admin.id, byUserId: admin.userId })
      .then(() => "booked", (e) => (e instanceof DoctorNotBookableError ? e.reason : `${(e as Error).constructor.name}: ${(e as Error).message}`));
  const portal = (start: Date) =>
    requestAppointment(scope, patientUser.id, { doctorStaffId: doctor.id, scheduledStart: start.toISOString() })
      .then(() => "booked", (e) => (e instanceof DoctorNotBookableError ? e.reason : `${(e as Error).constructor.name}: ${(e as Error).message}`));
  const apptCount = () => prisma.appointment.count({ where: { doctorStaffId: doctor.id } });

  // 1. Normal.
  report("A slot inside a session books", (await book(at(3, 9, 0))) === "booked");
  report("The slot list shows the session's slots", (await getAvailableSlots(doctor.id, at(3))).length === 15, `${(await getAvailableSlots(doctor.id, at(3))).length} slots`);

  // 2. Whole-day leave.
  await prisma.staffAbsence.create({ data: { facilityId, staffId: doctor.id, kind: "LEAVE", startAt: at(4), endAt: at(5), reason: "Annual leave" } });
  const before = await apptCount();
  report("On leave: the slot list is empty", (await getAvailableSlots(doctor.id, at(4))).length === 0);
  const hospitalOnLeave = await book(at(4, 10, 0));
  report("On leave: Hospital OS booking is refused", hospitalOnLeave === "ABSENT", hospitalOnLeave);
  const portalOnLeave = await portal(at(4, 10, 0));
  report("On leave: patient portal booking is refused", portalOnLeave === "ABSENT", portalOnLeave);
  report("On leave: no appointment was created", (await apptCount()) === before);

  // 3. Partial-day leave 10:00–11:00.
  await prisma.staffAbsence.create({ data: { facilityId, staffId: doctor.id, kind: "BLOCKED", startAt: at(5, 10), endAt: at(5, 11), reason: "Meeting" } });
  const partial = (await getAvailableSlots(doctor.id, at(5))).map((s) => hhmm(s.start));
  report("Partial leave removes only its slots", !partial.some((t) => t >= "10:00" && t < "11:00") && partial.includes("09:45") && partial.includes("11:00"), partial.join(" "));
  report("…booking inside it is refused", (await book(at(5, 10, 15))) === "ABSENT");
  report("…a slot that straddles its start is refused", (await book(at(5, 9, 45), 30)) === "ABSENT");
  report("…booking after it succeeds", (await book(at(5, 11, 0))) === "booked");

  // 4. Outside every session.
  report("Outside every session is refused", (await book(at(3, 14, 0))) === "NO_SESSION");
  report("…including a slot that runs past the session's end", (await book(at(3, 12, 50), 15)) === "NO_SESSION");

  // 5. Shifts.
  await prisma.staffShift.create({ data: { facilityId, staffId: doctor.id, startAt: at(6, 9), endAt: at(6, 11), assignedByStaffId: admin.id } });
  report("Rostered day: inside the shift books", (await book(at(6, 9, 30))) === "booked");
  report("Rostered day: off shift is refused", (await book(at(6, 11, 30))) === "OFF_SHIFT");
  report("…and the slot list stops at the shift's end", (await getAvailableSlots(doctor.id, at(6))).every((s) => hhmm(s.start) < "11:00"));
  await prisma.staffShift.create({ data: { facilityId, staffId: doctor.id, startAt: at(7, 8), endAt: at(7, 14), assignedByStaffId: admin.id, status: "CANCELLED", cancelledAt: new Date() } });
  report("A day whose only shift was cancelled has no slots", (await getAvailableSlots(doctor.id, at(7))).length === 0);
  report("…and can't be booked", (await book(at(7, 9, 0))) === "OFF_SHIFT");

  // 6. Other ways leave is entered.
  await setAvailability({ facilityId, staffId: doctor.id, availability: "ON_LEAVE", reason: "Sick", setByStaffId: admin.id, byUserId: admin.userId });
  report("Workforce ON_LEAVE: the staff member is unavailable", !(await isStaffAvailable(prisma, doctor.id, facilityId)));
  report("…and can't be booked (until further notice)", (await book(at(8, 9, 0))) === "ABSENT");
  report("…and the portal can't book either", (await portal(at(8, 9, 15))) === "ABSENT");
  await setAvailability({ facilityId, staffId: doctor.id, availability: "AVAILABLE", setByStaffId: admin.id, byUserId: admin.userId });
  report("Workforce AVAILABLE lifts it", (await isStaffAvailable(prisma, doctor.id, facilityId)) && (await book(at(8, 9, 0))) === "booked");

  // 7. One source.
  const blockCols = (await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'DoctorScheduleBlock'`).map((c) => c.column_name);
  report("DoctorScheduleBlock holds sessions only (no type/reason)", !blockCols.includes("type") && !blockCols.includes("reason"), blockCols.join(","));
  const availTable = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'StaffAvailability'`;
  report("StaffAvailability is gone", Number(availTable[0].n) === 0);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
