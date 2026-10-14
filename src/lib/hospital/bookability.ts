import type { Prisma, PrismaClient, DoctorScheduleBlock } from "@prisma/client";
import { ConflictError } from "@/lib/auth/rbac";

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
 * Session hours are minutes from local midnight, as before.
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
  dayStart: Date;
  sessions: DoctorScheduleBlock[];
  absences: { startAt: Date; endAt: Date | null }[];
  shifts: { startAt: Date; endAt: Date; status: string }[];
}

export function localDayStart(at: Date): Date {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d;
}

function sameLocalDate(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Everything the rule needs for one doctor on the local day containing `at`. */
export async function loadDayContext(db: Db, staffId: string, at: Date): Promise<DayContext> {
  const dayStart = localDayStart(at);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3_600_000);
  const [blocks, absences, shifts] = await Promise.all([
    db.doctorScheduleBlock.findMany({
      where: { staffId, OR: [{ dayOfWeek: dayStart.getDay(), specificDate: null }, { specificDate: { gte: dayStart, lt: dayEnd } }] },
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
  const sessions = blocks.filter((b) => (b.specificDate ? sameLocalDate(b.specificDate, dayStart) : b.dayOfWeek === dayStart.getDay()));
  return { dayStart, sessions, absences, shifts };
}

/** The session containing [start, end), or why the doctor isn't bookable then. */
export function evaluateBookability(ctx: DayContext, start: Date, end: Date):
  { bookable: true; session: DoctorScheduleBlock } | { bookable: false; reason: NotBookableReason } {
  const at = (minute: number) => ctx.dayStart.getTime() + minute * 60_000;
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
export async function assertBookable(db: Db, staffId: string, start: Date, end: Date): Promise<DoctorScheduleBlock> {
  const result = evaluateBookability(await loadDayContext(db, staffId, start), start, end);
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
