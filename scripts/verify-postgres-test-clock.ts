/**
 * RAG Phase 4 housekeeping — the midnight cases on the shared test clock.
 *
 * Three checks used the real time of day and failed near midnight India
 * time: the tenancy sweep's check-ins case (a check-in made "today", listed
 * on the desk's "today" after midnight), and two browser journeys (the
 * insurance check-in, whose "Check in" link needs a visit two hours ahead,
 * and the home screen's accessibility check, which needs that visit to be
 * the upcoming appointment). They now run on the app's clock frozen at 12:00
 * IST of the run's day (scripts/lib/testClock.ts, src/lib/time/clock.ts).
 *
 * This gate replays exactly what those cases set up and read, through the
 * same services, with the real clock at 23:59 and at 00:01 India time: a run
 * that starts at either minute, and a run that starts at 23:59 and is still
 * going at 00:01. A control at 23:59 with the test clock off shows the check
 * detects the failure.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { appNow } from "../src/lib/time/clock";
import { dayKey, facilityTimeZone } from "../src/lib/time/zone";
import { listAppointments, nextAppointment } from "../src/lib/patient/experience/appointments";
import { preRegistered, windowOpen } from "../src/lib/insurance/checkin";
import type { PatientAccessScope } from "../src/lib/patient/context";
import { RUN_START_ENV, TEST_CLOCK_ENV, freezeAppClockAtMidday } from "./lib/testClock";

const PUNE = "fac-amc-pune";
const TAG = "gate-test-clock";
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
}

const realNow = Date.now;
/** Runs `fn` with the real clock at `at` (Date.now only: what appNow and the fixtures read). */
async function atRealTime<T>(at: Date, fn: () => Promise<T>): Promise<T> {
  Date.now = () => at.getTime();
  try { return await fn(); } finally { Date.now = realNow; }
}
const ist = (iso: string) => new Date(`${iso}+05:30`);

async function cleanup() {
  await prisma.preArrivalCheckIn.deleteMany({ where: { token: { startsWith: "TC-" }, facilityId: PUNE } });
  await prisma.appointment.deleteMany({ where: { reason: { startsWith: TAG } } });
}

async function main() {
  const link = await prisma.personPatientLink.findFirstOrThrow({ where: { status: "ACTIVE", patient: { facilityId: PUNE } }, select: { personId: true, patientId: true } });
  const doctor = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { department: { facilityId: PUNE } }, select: { id: true } });
  const scope: PatientAccessScope = { patientId: link.patientId, patientIds: [link.patientId], facilityId: PUNE, isSelf: true, allowedClasses: new Set(["APPOINTMENTS"]) as PatientAccessScope["allowedClasses"] };
  const tz = await facilityTimeZone(prisma, PUNE);
  await cleanup();

  const scenarios: { name: string; runStart: Date; setUp: Date; read: Date; testClock: boolean }[] = [
    { name: "run starts at 23:59 IST", runStart: ist("2026-11-23T23:59:00"), setUp: ist("2026-11-23T23:59:00"), read: ist("2026-11-23T23:59:30"), testClock: true },
    { name: "run starts at 00:01 IST", runStart: ist("2026-11-24T00:01:00"), setUp: ist("2026-11-24T00:01:00"), read: ist("2026-11-24T00:01:30"), testClock: true },
    { name: "run starts at 23:59 IST, reads at 00:01 IST", runStart: ist("2026-11-23T23:59:00"), setUp: ist("2026-11-23T23:59:00"), read: ist("2026-11-24T00:01:00"), testClock: true },
    { name: "control: 23:59 IST, test clock off", runStart: ist("2026-11-23T23:59:00"), setUp: ist("2026-11-23T23:59:00"), read: ist("2026-11-24T00:01:00"), testClock: false },
  ];
  let n = 0;
  for (const s of scenarios) {
    const saved = { start: process.env[RUN_START_ENV], offset: process.env[TEST_CLOCK_ENV] };
    const apply = (real: Date) => {
      process.env[RUN_START_ENV] = String(s.runStart.getTime());
      if (s.testClock) freezeAppClockAtMidday(process.env, real.getTime());
      else delete process.env[TEST_CLOCK_ENV];
    };
    n++;
    // Set up as the cases do: the e2e fixture's visit (two hours ahead on the app's clock), the check-in the
    // patient submits for it (its token day is the visit's day), and the sweep's check-in (today's token day).
    apply(s.setUp);
    const made = await atRealTime(s.setUp, async () => {
      const start = new Date(appNow().getTime() + 120 * 60_000);
      const appt = await prisma.appointment.create({ data: { facilityId: PUNE, doctorStaffId: doctor.id, patientId: link.patientId, scheduledStart: start, scheduledEnd: new Date(start.getTime() + 900_000), createdByStaffId: doctor.id, reason: `${TAG} ${n}` } });
      const visitDay = dayKey(start, tz), sweepDay = dayKey(appNow(), tz);
      await prisma.preArrivalCheckIn.create({ data: { facilityId: PUNE, kind: "APPOINTMENT", appointmentId: appt.id, patientId: link.patientId, personId: link.personId, eligibility: "SELF_PAY", token: `TC-${n}A`, tokenDay: visitDay, submittedByPersonId: link.personId } });
      await prisma.preArrivalCheckIn.create({ data: { facilityId: PUNE, kind: "APPOINTMENT", patientId: link.patientId, personId: link.personId, eligibility: "PENDING", token: `TC-${n}B`, tokenDay: sweepDay, submittedByPersonId: link.personId } });
      return { appt, start };
    });
    // Read as the cases do, possibly after midnight.
    apply(s.read);
    const seen = await atRealTime(s.read, async () => {
      const list = await listAppointments(scope);
      const dto = list.upcoming.find((a) => a.id === made.appt.id);
      const next = await nextAppointment(scope);
      const desk = await preRegistered(PUNE);
      return { upcoming: !!dto, checkInLink: !!dto?.checkInOpen, windowOpen: windowOpen(made.start), home: next?.id === made.appt.id, desk: JSON.stringify(desk) };
    });
    const deskHas = (t: string) => seen.desk.includes(`"${t}"`);
    const allOk = seen.upcoming && seen.checkInLink && seen.windowOpen && seen.home && deskHas(`TC-${n}A`) && deskHas(`TC-${n}B`);
    if (s.testClock) {
      check(`${s.name}: the visit is upcoming and the home screen's next appointment (e2e a11y)`, seen.upcoming && seen.home);
      check(`${s.name}: the "Check in" link shows and the window is open (e2e insurance)`, seen.checkInLink && seen.windowOpen);
      check(`${s.name}: the desk's "today" lists both check-ins (tenancy sweep)`, deskHas(`TC-${n}A`) && deskHas(`TC-${n}B`));
    } else {
      check(`${s.name}: on the real clock the cases fail across midnight, so this gate can tell`, !allOk);
    }
    if (saved.start === undefined) delete process.env[RUN_START_ENV]; else process.env[RUN_START_ENV] = saved.start;
    if (saved.offset === undefined) delete process.env[TEST_CLOCK_ENV]; else process.env[TEST_CLOCK_ENV] = saved.offset;
    await cleanup();
  }
  console.log(`\n${passed} passed, ${failed} failed.`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); await prisma.$disconnect(); process.exit(1); });
