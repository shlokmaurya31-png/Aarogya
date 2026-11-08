import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Flagship 2a (pre-launch item 25): wall-clock time in a named IANA zone,
 * never the server process's own. Every facility has a `timeZone` (default
 * Asia/Kolkata); clinic sessions, "today", check-in windows, summaries and
 * reminders are computed in it, so a server in UTC or in California offers
 * the same "09:00" clinic as one in Mumbai.
 *
 * Nothing here reads `Date#getHours`/`setHours` or `TZ`: the zone is always
 * an argument, and the offset at a moment comes from Intl (so a zone with
 * daylight saving is handled too, and a day can be 23 or 25 hours long).
 */
export const DEFAULT_TIME_ZONE = "Asia/Kolkata";

type Db = PrismaClient | Prisma.TransactionClient;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Is `tz` an IANA zone this runtime knows (e.g. "Asia/Kolkata")? */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try { formatter(tz); return true; } catch { return false; }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }

/** The wall-clock date and time of `at` in `timeZone` (month 1–12, weekday 0 = Sunday). */
export function zonedParts(at: Date, timeZone: string): ZonedParts {
  const p: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(at)) p[part.type] = part.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second, weekday: WEEKDAYS[p.weekday] };
}

/** Minutes the zone is ahead of UTC at `at` (Asia/Kolkata: 330). */
export function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The zone's calendar day of `at`, as YYYY-MM-DD. */
export function dayKey(at: Date, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** A YYYY-MM-DD string that is a real calendar date, or null. */
export function parseDayKey(s: unknown): string | null {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

/** The day key `n` calendar days after `day` (negative for before). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The instant at which the wall clock in `timeZone` reads `minute` minutes
 * after midnight on `day`. On a daylight-saving gap the later reading is
 * used; India has none.
 */
export function zonedInstant(day: string, minute: number, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minute);
  let t = wall - zoneOffsetMinutes(new Date(wall), timeZone) * 60_000;
  // A second pass settles a guess that landed across an offset change.
  t = wall - zoneOffsetMinutes(new Date(t), timeZone) * 60_000;
  return new Date(t);
}

export interface ZonedDay { day: string; start: Date; end: Date; weekday: number }

/** The zone's day containing `at` (or the day named by a YYYY-MM-DD key), with its bounds. */
export function zonedDay(at: Date | string, timeZone: string): ZonedDay {
  const day = typeof at === "string" ? (parseDayKey(at) ?? (() => { throw new Error(`Not a day: ${at}`); })()) : dayKey(at, timeZone);
  const start = zonedInstant(day, 0, timeZone);
  const end = zonedInstant(addDays(day, 1), 0, timeZone);
  return { day, start, end, weekday: new Date(`${day}T00:00:00Z`).getUTCDay() };
}

/** Start of the zone's day containing `at`. */
export function startOfZonedDay(at: Date, timeZone: string): Date {
  return zonedDay(at, timeZone).start;
}

/** Minutes after the zone's midnight at `at` (09:30 → 570). */
export function minuteOfDay(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  return p.hour * 60 + p.minute;
}

/** A facility's zone (its own setting; the default for an unknown id). */
export async function facilityTimeZone(db: Db, facilityId: string | null | undefined): Promise<string> {
  if (!facilityId) return DEFAULT_TIME_ZONE;
  const f = await db.facility.findUnique({ where: { id: facilityId }, select: { timeZone: true } });
  return f && isValidTimeZone(f.timeZone) ? f.timeZone : DEFAULT_TIME_ZONE;
}
