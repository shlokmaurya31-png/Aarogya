/**
 * Flagship 1a — the shared gate clock. No gate may depend on the real time of
 * day or the real date: a gate that books "the next free slot" or "an hour from
 * now" passes at 10:00 and fails at 23:30, because the services filter past
 * slots and group check-ins and summaries by India day.
 *
 * Two parts:
 *   1. One time zone. Every gate, the apps and workers they start, and the
 *      browser journeys run with TZ=Asia/Kolkata (GATE_TZ), so the process's
 *      local day (clinic sessions, `localDayStart`) is the India day (check-in
 *      tokens, access summaries). Without it the gates ran in London on a
 *      laptop and in UTC in CI, and "today" meant two different days for
 *      5½ hours of every day. gateBootstrap applies it before anything loads.
 *   2. Fixed anchors. A gate reads `gateClock.now()` (frozen when the process
 *      starts) and picks days and times from it that are far from any boundary:
 *      `bookingDay()` is the India day after tomorrow, so every clinic session
 *      on it is wholly in the future whatever the time now; `sameIndiaDay()`
 *      gives a time on today's India day even at 23:50.
 *
 * Every helper is pure given its `now`, so testClock.test.ts proves the
 * properties for every minute of a day.
 */
export const GATE_TZ = "Asia/Kolkata";
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** The India calendar date of an instant (YYYY-MM-DD). */
export function indiaDate(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant an India day starts (00:00 IST). */
export function indiaMidnight(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS);
}

export interface GateClock {
  /** The frozen "now" of this run (the moment the clock was made). */
  now(): Date;
  /** 00:00 IST of the India day `days` after today's (0 = today). */
  indiaDay(days: number): Date;
  /** hh:mm IST on the India day `days` after today's. */
  at(days: number, hh: number, mm?: number): Date;
  /**
   * The day gates book clinic slots on: 00:00 IST of the day after tomorrow.
   * Its whole day lies at least 24 hours ahead, so no slot on it has passed and
   * the next-slot projection (14 days) still covers it.
   */
  bookingDay(): Date;
  /**
   * A `durationMin`-long time on today's India day, `aheadMin` from now when
   * that still ends today, else `aheadMin` before now (late in the day, an
   * earlier time today). For fixtures that need "a visit today".
   */
  sameIndiaDay(aheadMin: number, durationMin?: number): Date;
}

export function makeGateClock(real: Date = new Date()): GateClock {
  const frozen = new Date(real.getTime());
  const today = indiaDate(frozen);
  const indiaDay = (days: number) => new Date(indiaMidnight(today).getTime() + days * DAY_MS);
  return {
    now: () => new Date(frozen.getTime()),
    indiaDay,
    at: (days, hh, mm = 0) => new Date(indiaDay(days).getTime() + (hh * 60 + mm) * MINUTE_MS),
    bookingDay: () => indiaDay(2),
    sameIndiaDay(aheadMin, durationMin = 15) {
      const ahead = new Date(frozen.getTime() + aheadMin * MINUTE_MS);
      if (indiaDate(new Date(ahead.getTime() + durationMin * MINUTE_MS - 1)) === today) return ahead;
      return new Date(frozen.getTime() - (aheadMin + durationMin) * MINUTE_MS);
    },
  };
}

/** This process's clock. */
export const gateClock = makeGateClock();
