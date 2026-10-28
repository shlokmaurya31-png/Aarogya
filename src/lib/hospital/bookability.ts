import type { Prisma, PrismaClient, DoctorScheduleBlock } from "@prisma/client";
import { ConflictError } from "@/lib/auth/rbac";
import { dayKey, zonedDay, zonedInstant } from "@/lib/time/zone";

/**
 * D7: when a doctor can be booked. One rule, used by slot listing and by
 * booking alike:
 *
 *   bookable(t) = inside a DoctorScheduleBlock session
 *               AND not inside any StaffAbsence (leave, holiday, blocked, …)
 *               AND not off shift.
 *
 * "Off shift": on a day the doctor is rostered (has any StaffShift starting
 * that day, cancelled ones included), the time must fall inside a SCHEDULED or
 * COMPLETED shift. On a day with no roster, the clinic session alone is the
 * working time — outpatient doctors aren't necessarily rostered.
 *
 * Session hours are minutes from midnight in the facility's time zone
 * (Flagship 2a, pre-launch item 25: never the server's own zone), and the day
 * is that zone's day.
 */

type Db = PrismaClient | Prisma.TransactionClient;
export type NotBookableReason = "NO_SESSION" | "ABSENT" | "OFF_SHIFT";

export class DoctorNotBookableError extends ConflictError {
  constructor(public reason: NotBookableReason) {
    super(
      reason === "ABSENT" ? "The doctor is on leave or unavailable at that time."
        : reason === "OFF_SHIFT" ? "The doctor is not on shift at that time."
          : "That time is outside the doctor's clinic sessions."
    );
  }
}

export interface DayContext {
  /** The facility's day (YYYY-MM-DD) and zone. */
  day: string;
  timeZone: string;
  dayStart: Date;
  dayEnd: Date;
  sessions: DoctorScheduleBlock[];
  absences: { startAt: Date; endAt: Date | null }[];
  shifts: { startAt: Date; endAt: Date; status: string }[];
}

/** The instant a session minute falls at on the context's day (in its zone). */
export function sessionInstant(ctx: Pick<DayContext, "day" | "timeZone">, minute: number): Date {
  return zonedInstant(ctx.day, minute, ctx.timeZone);
}

/**
 * Everything the rule needs for one doctor on the day containing `at` (or the
 * day named by a YYYY-MM-DD key) in `timeZone`, the facility's zone.
 */
export async function loadDayContext(db: Db, staffId: string, at: Date | string, timeZone: string): Promise<DayContext> {
  const { day, start: dayStart, end: dayEnd, weekday } = zonedDay(at, timeZone);
  // A one-off session's date is a calendar date, stored as a midnight in some
  // zone: read a day either side and keep the ones whose date is this day.
  const near = { gte: new Date(dayStart.getTime() - 86_400_000), lt: new Date(dayEnd.getTime() + 86_400_000) };
  const [blocks, absences, shifts] = await Promise.all([
    db.doctorScheduleBlock.findMany({
      where: { staffId, OR: [{ dayOfWeek: weekday, specificDate: null }, { specificDate: near }] },
      orderBy: [{ specificDate: { sort: "desc", nulls: "last" } }, { createdAt: "asc" }, { id: "asc" }],
    }),
    db.staffAbsence.findMany({
      where: { staffId, cancelledAt: null, startAt: { lt: dayEnd }, OR: [{ endAt: null }, { endAt: { gt: dayStart } }] },
      select: { startAt: true, endAt: true },
    }),
    db.staffShift.findMany({
      where: { staffId, startAt: { gte: dayStart, lt: dayEnd } },
      select: { startAt: true, endAt: true, status: true },
    }),
  ]);
  const sessions = blocks.filter((b) => (b.specificDate ? specificDay(b.specificDate, timeZone) === day : b.dayOfWeek === weekday));
  return { day, timeZone, dayStart, dayEnd, sessions, absences, shifts };
}

/**
 * The calendar date of a one-off session. Stored as UTC midnight (a
 * YYYY-MM-DD from the API) or as the zone's midnight (older rows written under
 * a server in India time): both name the same date in a zone east of UTC.
 */
export function specificDay(d: Date, timeZone: string): string {
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 ? d.toISOString().slice(0, 10) : dayKey(d, timeZone);
}

/** The session containing [start, end), or why the doctor isn't bookable then. */
export function evaluateBookability(ctx: DayContext, start: Date, end: Date):
  { bookable: true; session: DoctorScheduleBlock } | { bookable: false; reason: NotBookableReason } {
  const at = (minute: number) => sessionInstant(ctx, minute).getTime();
  const session = ctx.sessions.find((s) => at(s.startMinute) <= start.getTime() && end.getTime() <= at(s.endMinute));
  if (!session) return { bookable: false, reason: "NO_SESSION" };
  const absent = ctx.absences.some((a) => a.startAt.getTime() < end.getTime() && (a.endAt === null || a.endAt.getTime() > start.getTime()));
  if (absent) return { bookable: false, reason: "ABSENT" };
  if (ctx.shifts.length > 0) {
    const onShift = ctx.shifts.some((s) => s.status !== "CANCELLED" && s.startAt.getTime() <= start.getTime() && end.getTime() <= s.endAt.getTime());
    if (!onShift) return { bookable: false, reason: "OFF_SHIFT" };
  }
  return { bookable: true, session };
}

/** Throws DoctorNotBookableError unless the doctor is bookable for [start, end). */
export async function assertBookable(db: Db, staffId: string, start: Date, end: Date, timeZone: string): Promise<DoctorScheduleBlock> {
  const result = evaluateBookability(await loadDayContext(db, staffId, start, timeZone), start, end);
  if (!result.bookable) throw new DoctorNotBookableError(result.reason);
  return result.session;
}

/** Is the staff member inside any absence at `at`? (Workforce views.) */
export async function isAbsentAt(db: Db, staffId: string, at: Date): Promise<boolean> {
  const n = await db.staffAbsence.count({
    where: { staffId, cancelledAt: null, startAt: { lte: at }, OR: [{ endAt: null }, { endAt: { gt: at } }] },
  });
  return n > 0;
}

/** Where-clause for absences in effect at `at`. */
export function absenceInEffectWhere(at: Date): Prisma.StaffAbsenceWhereInput {
  return { cancelledAt: null, startAt: { lte: at }, OR: [{ endAt: null }, { endAt: { gt: at } }] };
}
