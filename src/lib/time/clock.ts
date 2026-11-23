/**
 * The app's clock for decisions that depend on the time of day or the India
 * day: which check-ins are "today", whether a pre-arrival check-in window is
 * open, which appointments are upcoming. Real time, always — except that a
 * gate or a browser journey may run the app shifted by a fixed offset
 * (AAROGYA_TEST_CLOCK_OFFSET_MS, so a run at 23:59 behaves as at mid-day the
 * same India day; scripts/lib/testClock.ts), and only while the app is
 * connected to the local verify database. Never in production, staging or
 * development: any other database ignores the variable.
 */
const MAX_OFFSET_MS = 2 * 86_400_000;
const TEST_CLOCK_ENV = "AAROGYA_TEST_CLOCK_OFFSET_MS";

export function testClockOffsetMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env[TEST_CLOCK_ENV];
  if (!raw) return 0;
  try {
    const url = new URL(env.DATABASE_URL ?? "");
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname) || url.pathname !== "/aarogya_verify") return 0;
  } catch {
    return 0;
  }
  const n = Number(raw);
  return Number.isFinite(n) && Math.abs(n) <= MAX_OFFSET_MS ? Math.trunc(n) : 0;
}

export function appNow(): Date {
  return new Date(Date.now() + testClockOffsetMs());
}
