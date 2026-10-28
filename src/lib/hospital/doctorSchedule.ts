import { prisma } from "@/lib/db";
import { loadDayContext, evaluateBookability, sessionInstant } from "./bookability";
import { facilityTimeZone } from "@/lib/time/zone";

/**
 * Doctor scheduling foundation (brief §7) — clinic sessions
 * (DoctorScheduleBlock), with leave/holiday/blocked time in StaffAbsence (D7),
 * no payroll/HR. Available slots are computed on demand, not
 * pre-generated/persisted — avoids a second source of truth that would
 * need to be regenerated whenever a block changes.
 */
export interface AvailableSlot {
  start: string; // ISO
  end: string;
  roomLabel: string | null;
  remainingCapacity: number;
}

/**
 * Computes bookable slots for one doctor on one date: each slot of each clinic
 * session that passes the D7 bookability rule (no absence, not off shift) and
 * has capacity left, at one facility's sessions. The date is that facility's
 * day (a YYYY-MM-DD key, or the day containing a moment) in its time zone
 * (Flagship 2a), whatever zone the server runs in.
 */
export async function getAvailableSlots(staffId: string, date: Date | string, opts: { facilityId: string }): Promise<AvailableSlot[]> {
  const ctx = await loadDayContext(prisma, staffId, date, await facilityTimeZone(prisma, opts.facilityId));
  // Week 5a: one doctor, several places: only that facility's sessions (the lock and overlaps stay per doctor).
  ctx.sessions = ctx.sessions.filter((s) => s.facilityId === opts.facilityId);
  if (ctx.sessions.length === 0) return [];
  const { dayStart, dayEnd } = ctx;

  const existing = await prisma.appointment.findMany({
    where: { doctorStaffId: staffId, scheduledStart: { gte: dayStart, lt: dayEnd }, status: { notIn: ["CANCELLED", "NO_SHOW"] } },
    select: { scheduledStart: true },
  });
  const bookedCount = new Map<number, number>();
  for (const a of existing) {
    const key = a.scheduledStart.getTime();
    bookedCount.set(key, (bookedCount.get(key) ?? 0) + 1);
  }

  const slots: AvailableSlot[] = [];
  for (const session of ctx.sessions) {
    const duration = session.slotDurationMinutes ?? 15;
    const maxConcurrent = session.maxConcurrentAppointments;
    for (let minute = session.startMinute; minute + duration <= session.endMinute; minute += duration) {
      const start = sessionInstant(ctx, minute);
      const end = new Date(start.getTime() + duration * 60_000);
      if (!evaluateBookability(ctx, start, end).bookable) continue;
      const booked = bookedCount.get(start.getTime()) ?? 0;
      const remaining = maxConcurrent - booked;
      if (remaining > 0) {
        slots.push({ start: start.toISOString(), end: end.toISOString(), roomLabel: session.roomLabel, remainingCapacity: remaining });
      }
    }
  }
  return slots.sort((a, b) => a.start.localeCompare(b.start));
}
