import { prisma } from "@/lib/db";

/**
 * Doctor scheduling foundation (brief §7) — working hours, leave/holiday/
 * blocked periods and clinic sessions only, no payroll/HR. Available
 * slots are computed on demand from `DoctorScheduleBlock` rows, not
 * pre-generated/persisted — avoids a second source of truth that would
 * need to be regenerated whenever a block changes.
 */
export interface AvailableSlot {
  start: string; // ISO
  end: string;
  roomLabel: string | null;
  remainingCapacity: number;
}

function isSameCalendarDate(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

/** Computes bookable slots for one doctor on one date, honoring blocked/leave/holiday overrides and existing bookings. */
export async function getAvailableSlots(staffId: string, date: Date): Promise<AvailableSlot[]> {
  const dayOfWeek = date.getDay();
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3_600_000);

  const blocks = await prisma.doctorScheduleBlock.findMany({
    where: {
      staffId,
      OR: [{ dayOfWeek }, { specificDate: { gte: dayStart, lt: dayEnd } }],
    },
  });

  // A one-off LEAVE/HOLIDAY/BLOCKED override for this specific date cancels any recurring session that day.
  const dayOverride = blocks.find((b) => b.specificDate && isSameCalendarDate(b.specificDate, date) && b.type !== "CLINIC_SESSION");
  if (dayOverride) return [];

  const sessions = blocks.filter(
    (b) => b.type === "CLINIC_SESSION" && b.startMinute != null && b.endMinute != null && (b.specificDate ? isSameCalendarDate(b.specificDate, date) : b.dayOfWeek === dayOfWeek)
  );
  if (sessions.length === 0) return [];

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
  for (const session of sessions) {
    const duration = session.slotDurationMinutes ?? 15;
    const maxConcurrent = session.maxConcurrentAppointments;
    for (let minute = session.startMinute!; minute + duration <= session.endMinute!; minute += duration) {
      const start = new Date(dayStart.getTime() + minute * 60_000);
      const end = new Date(start.getTime() + duration * 60_000);
      const booked = bookedCount.get(start.getTime()) ?? 0;
      const remaining = maxConcurrent - booked;
      if (remaining > 0) {
        slots.push({ start: start.toISOString(), end: end.toISOString(), roomLabel: session.roomLabel, remainingCapacity: remaining });
      }
    }
  }
  return slots.sort((a, b) => a.start.localeCompare(b.start));
}
