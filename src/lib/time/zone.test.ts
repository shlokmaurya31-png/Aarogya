import { describe, expect, it } from "vitest";
import { addDays, dayKey, isValidTimeZone, minuteOfDay, parseDayKey, zonedDay, zonedInstant, zoneOffsetMinutes, zonedParts } from "./zone";
import { specificDay } from "@/lib/hospital/bookability";

const IST = "Asia/Kolkata";
const LA = "America/Los_Angeles";

describe("time zones (Flagship 2a)", () => {
  it("knows real IANA zones and refuses anything else", () => {
    expect(isValidTimeZone(IST)).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    for (const bad of ["", "Mars/Olympus", "IST; DROP", 42, null, "../etc"]) expect(isValidTimeZone(bad)).toBe(false);
  });

  it("India is UTC+05:30 all year", () => {
    expect(zoneOffsetMinutes(new Date("2026-01-15T00:00:00Z"), IST)).toBe(330);
    expect(zoneOffsetMinutes(new Date("2026-07-15T00:00:00Z"), IST)).toBe(330);
  });

  it("an India day starts at 18:30 UTC the evening before", () => {
    const d = zonedDay("2026-10-29", IST);
    expect(d.start.toISOString()).toBe("2026-10-28T18:30:00.000Z");
    expect(d.end.toISOString()).toBe("2026-10-29T18:30:00.000Z");
    expect(d.weekday).toBe(4); // Thursday
  });

  it("the India day of a moment, at every minute either side of midnight", () => {
    const midnight = Date.parse("2026-10-28T18:30:00Z");
    for (let m = -90; m <= 90; m++) {
      const at = new Date(midnight + m * 60_000);
      expect(dayKey(at, IST)).toBe(m < 0 ? "2026-10-28" : "2026-10-29");
      expect(zonedDay(at, IST).start.toISOString()).toBe(m < 0 ? "2026-10-27T18:30:00.000Z" : "2026-10-28T18:30:00.000Z");
    }
  });

  it("wall-clock minutes round-trip", () => {
    for (const minute of [0, 1, 540, 570, 779, 1439]) {
      const at = zonedInstant("2026-10-29", minute, IST);
      expect(minuteOfDay(at, IST)).toBe(minute);
      expect(dayKey(at, IST)).toBe("2026-10-29");
    }
    expect(zonedInstant("2026-10-29", 540, IST).toISOString()).toBe("2026-10-29T03:30:00.000Z");
  });

  it("handles a zone with daylight saving (days of 23 and 25 hours)", () => {
    const spring = zonedDay("2026-03-08", LA);
    expect((spring.end.getTime() - spring.start.getTime()) / 3_600_000).toBe(23);
    const autumn = zonedDay("2026-11-01", LA);
    expect((autumn.end.getTime() - autumn.start.getTime()) / 3_600_000).toBe(25);
    expect(zonedInstant("2026-07-01", 540, LA).toISOString()).toBe("2026-07-01T16:00:00.000Z");
    expect(zonedInstant("2026-12-01", 540, LA).toISOString()).toBe("2026-12-01T17:00:00.000Z");
  });

  it("parts, day keys and calendar arithmetic", () => {
    expect(zonedParts(new Date("2026-10-28T20:00:00Z"), IST)).toMatchObject({ year: 2026, month: 10, day: 29, hour: 1, minute: 30, weekday: 4 });
    expect(parseDayKey("2026-02-30")).toBeNull();
    expect(parseDayKey("2026-2-3")).toBeNull();
    expect(parseDayKey("2026-12-31")).toBe("2026-12-31");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("a one-off session's date reads the same whether stored at UTC or India midnight", () => {
    expect(specificDay(new Date("2026-10-29T00:00:00Z"), IST)).toBe("2026-10-29");
    expect(specificDay(new Date("2026-10-28T18:30:00Z"), IST)).toBe("2026-10-29");
  });
});
