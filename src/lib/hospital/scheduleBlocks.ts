import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { isStaffInFacility } from "@/lib/auth/staffFacility";
import { dayKey, facilityTimeZone, parseDayKey, zonedInstant } from "@/lib/time/zone";

/**
 * A doctor's schedule (batch 7, item 5; previously written by its route): a
 * recurring or dated clinic session, or leave / a holiday / blocked time as a
 * StaffAbsence. Schedule configuration: bookability reads it on demand, so it
 * emits nothing (CONFIGURATION in emitExemptions.ts).
 */
export interface ScheduleBlockInput {
  facilityId: string; staffId: string; departmentId?: string; type: "CLINIC_SESSION" | "BLOCKED" | "LEAVE" | "HOLIDAY";
  dayOfWeek?: number; specificDate?: string; startMinute?: number; endMinute?: number; slotDurationMinutes?: number;
  maxConcurrentAppointments?: number; roomLabel?: string; reason?: string; recordedByStaffId?: string | null;
}

/**
 * A specificDate as the facility's calendar day (Flagship 2a): a YYYY-MM-DD
 * as given, or the facility-zone day of a full timestamp.
 */
function facilityDay(value: string, timeZone: string): string {
  const key = parseDayKey(value);
  if (key) return key;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new BadRequestError("specificDate is not a valid date.");
  return dayKey(at, timeZone);
}

export async function createScheduleBlock(d: ScheduleBlockInput) {
  if (!(await isStaffInFacility(prisma, d.staffId, d.facilityId))) throw new NotFoundError("Doctor not found.");
  const timeZone = await facilityTimeZone(prisma, d.facilityId);
  if (d.type === "CLINIC_SESSION") {
    if (d.dayOfWeek === undefined && !d.specificDate) throw new BadRequestError("Either dayOfWeek or specificDate is required.");
    if (d.startMinute === undefined || d.endMinute === undefined || d.endMinute <= d.startMinute) throw new BadRequestError("A clinic session needs startMinute and a later endMinute.");
    const block = await prisma.doctorScheduleBlock.create({
      data: {
        staffId: d.staffId, facilityId: d.facilityId, departmentId: d.departmentId, dayOfWeek: d.dayOfWeek,
        // A calendar date, stored as its UTC midnight (bookability's specificDay).
        specificDate: d.specificDate ? new Date(`${facilityDay(d.specificDate, timeZone)}T00:00:00Z`) : undefined, startMinute: d.startMinute, endMinute: d.endMinute,
        slotDurationMinutes: d.slotDurationMinutes, maxConcurrentAppointments: d.maxConcurrentAppointments, roomLabel: d.roomLabel,
      },
    });
    return { block };
  }
  if (!d.specificDate) throw new BadRequestError("Leave, holidays and blocked time need a specificDate.");
  // The facility's day and wall-clock minutes, in its time zone.
  const day = facilityDay(d.specificDate, timeZone);
  const startAt = zonedInstant(day, d.startMinute ?? 0, timeZone);
  const endAt = zonedInstant(day, d.endMinute ?? 1440, timeZone);
  if (endAt <= startAt) throw new BadRequestError("endMinute must be after startMinute.");
  const absence = await prisma.staffAbsence.create({ data: { facilityId: d.facilityId, staffId: d.staffId, kind: d.type, startAt, endAt, reason: d.reason, recordedByStaffId: d.recordedByStaffId ?? undefined } });
  return { absence };
}
