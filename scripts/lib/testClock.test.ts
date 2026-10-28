import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GATE_TZ, indiaDate, indiaMidnight, makeGateClock } from "./testClock";

// Every minute of one India day, plus the DST-free edges either side.
const START = Date.parse("2026-10-27T18:30:00Z"); // 2026-10-28 00:00 IST
const minutes = Array.from({ length: 24 * 60 + 2 }, (_, i) => new Date(START - 60_000 + i * 60_000));

describe("gate clock", () => {
  it("knows the India day of an instant and when it starts", () => {
    expect(indiaDate(new Date("2026-10-27T18:29:59Z"))).toBe("2026-10-27");
    expect(indiaDate(new Date("2026-10-27T18:30:00Z"))).toBe("2026-10-28");
    expect(indiaMidnight("2026-10-28").toISOString()).toBe("2026-10-27T18:30:00.000Z");
  });

  it("freezes now", () => {
    const c = makeGateClock(new Date("2026-10-28T10:00:00Z"));
    expect(c.now().toISOString()).toBe("2026-10-28T10:00:00.000Z");
    c.now().setTime(0);
    expect(c.now().toISOString()).toBe("2026-10-28T10:00:00.000Z");
  });

  it("the booking day's sessions (09:00–17:00 IST) are wholly ahead at every minute of the day", () => {
    for (const now of minutes) {
      const c = makeGateClock(now);
      const day = c.bookingDay();
      expect(indiaMidnight(indiaDate(day)).getTime()).toBe(day.getTime());
      expect(day.getTime() - now.getTime()).toBeGreaterThan(24 * 3_600_000);
      expect(day.getTime() + 17 * 3_600_000 - now.getTime()).toBeLessThan(14 * 86_400_000);
    }
  });

  it("at() is hh:mm IST on the chosen India day", () => {
    const c = makeGateClock(new Date("2026-10-28T20:00:00Z")); // 01:30 IST on the 29th
    expect(c.at(0, 10).toISOString()).toBe("2026-10-29T04:30:00.000Z");
    expect(c.at(3, 9, 15).toISOString()).toBe("2026-11-01T03:45:00.000Z");
  });

  it("sameIndiaDay stays on today's India day at every minute, ahead when it fits", () => {
    for (const now of minutes) {
      const c = makeGateClock(now);
      for (const [ahead, dur] of [[120, 15], [5, 30], [60, 60]]) {
        const t = c.sameIndiaDay(ahead, dur);
        expect(indiaDate(t)).toBe(indiaDate(now));
        expect(indiaDate(new Date(t.getTime() + dur * 60_000 - 1))).toBe(indiaDate(now));
        if (indiaDate(new Date(now.getTime() + (ahead + dur) * 60_000 - 1)) === indiaDate(now)) expect(t.getTime()).toBe(now.getTime() + ahead * 60_000);
      }
    }
  });

  it("the gate bootstrap, verify:all and the browser journeys pin the India time zone", () => {
    const read = (f: string) => readFileSync(path.join(__dirname, "..", f), "utf8");
    expect(GATE_TZ).toBe("Asia/Kolkata");
    expect(read("lib/gateBootstrap.ts")).toMatch(/process\.env\.TZ = GATE_TZ/);
    expect(read("verify-all.ts")).toMatch(/TZ: GATE_TZ/);
    expect(read("e2e-smoke.ts")).toMatch(/TZ: GATE_TZ/);
  });
});
