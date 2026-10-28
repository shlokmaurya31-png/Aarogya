/**
 * Flagship 2a — the time-zone gate's probe. verify-postgres-time-zones runs
 * this under TZ=Asia/Kolkata, TZ=UTC and TZ=America/Los_Angeles and compares
 * what the services answer: the facility's day and slots must not move with
 * the server's zone.
 *
 * It does not import gateBootstrap (which pins TZ to India: the point here is
 * to run in another zone), so it applies the same database guard itself before
 * anything loads. Input: TZ_PROBE (JSON) in the environment. Output: one JSON
 * line on stdout.
 */
import { gateDatabaseProblem } from "./gateGuard";

interface ProbeInput {
  now: string; facilityId: string; staffId: string; locationId: string; bookingDay: string;
  leaveStaffId: string; leaveDay: string; oneOffDay: string;
}

async function main() {
  const problem = gateDatabaseProblem(process.env);
  if (problem) { console.error(`Refusing to start the time-zone probe: ${problem}`); process.exit(2); }
  const input = JSON.parse(process.env.TZ_PROBE ?? "{}") as ProbeInput;
  const now = new Date(input.now);
  const { prisma } = await import("../../src/lib/db");
  const { getAvailableSlots } = await import("../../src/lib/hospital/doctorSchedule");
  const { refreshNextSlot } = await import("../../src/lib/doctors/slots");
  const { istDay } = await import("../../src/lib/person/notifications");
  const { preRegistered } = await import("../../src/lib/insurance/checkin");
  const { resolveWindow, startOfToday } = await import("../../src/lib/hospital-os/command-center/filters");
  const { createScheduleBlock } = await import("../../src/lib/hospital/scheduleBlocks");
  const { facilityTimeZone } = await import("../../src/lib/time/zone");

  const tz = await facilityTimeZone(prisma, input.facilityId);
  const starts = async (day: Date | string, staffId = input.staffId) => (await getAvailableSlots(staffId, day, { facilityId: input.facilityId })).map((s) => s.start);
  // Each probe run writes its own leave and one-off session (same day, same minutes), and reports where they landed.
  const leave = await createScheduleBlock({ facilityId: input.facilityId, staffId: input.leaveStaffId, type: "LEAVE", specificDate: input.leaveDay, startMinute: 600, endMinute: 660, reason: "tz probe" });
  const oneOff = await createScheduleBlock({ facilityId: input.facilityId, staffId: input.leaveStaffId, type: "CLINIC_SESSION", specificDate: input.oneOffDay, startMinute: 1080, endMinute: 1140, slotDurationMinutes: 30, maxConcurrentAppointments: 1 });
  const out = {
    processTz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    facilityTz: tz,
    slotsByKey: await starts(input.bookingDay),
    // The same day named by a moment inside it (01:00 India time, which is the previous evening in UTC and LA).
    slotsByMoment: await starts(new Date(Date.parse(`${input.bookingDay}T01:00:00+05:30`))),
    nextSlot: (await refreshNextSlot(input.locationId, now))?.toISOString() ?? null,
    personDay: istDay(now).day,
    checkInDay: (await preRegistered(input.facilityId)).day,
    todayFrom: resolveWindow("today", null, null, now, tz).from.toISOString(),
    startOfToday: startOfToday(now, tz).toISOString(),
    leave: "absence" in leave && leave.absence ? [leave.absence.startAt.toISOString(), leave.absence.endAt?.toISOString() ?? null] : null,
    oneOffStored: "block" in oneOff && oneOff.block ? oneOff.block.specificDate?.toISOString() ?? null : null,
    // Slots on the leave day: the morning session minus the leave hour, plus the evening one-off session.
    leaveDaySlots: await starts(input.leaveDay, input.leaveStaffId),
  };
  await prisma.$disconnect();
  console.log(JSON.stringify(out));
}

main().catch((e) => { console.error(e); process.exit(1); });
