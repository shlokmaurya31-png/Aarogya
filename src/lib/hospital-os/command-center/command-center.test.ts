import { describe, it, expect } from "vitest";
import { statusFromThreshold, worstStatus, type Threshold } from "./types";
import { resolveWindow } from "./filters";
import { THRESHOLD_DEFAULTS } from "./thresholds";
import { isDrillKind, DRILLDOWN_KINDS } from "./drilldowns";
import { ALL_SECTIONS } from "./authz";

/**
 * Phase D10 — pure Command Center unit tests (status semantics, thresholds, time
 * windows, drill-down allow-list). DB-backed metric correctness + tenant/role/privacy
 * isolation + zero/unavailable states are proven by
 * scripts/verify-postgres-d10-command-center.ts.
 */

const t = (warning: number, critical: number, direction: "HIGHER_WORSE" | "LOWER_WORSE" = "HIGHER_WORSE"): Threshold =>
  ({ warning, critical, direction, unit: "%", source: "DEFAULT" });

describe("status from threshold", () => {
  it("maps higher-worse metrics correctly", () => {
    expect(statusFromThreshold(50, t(85, 95))).toBe("NORMAL");
    expect(statusFromThreshold(88, t(85, 95))).toBe("WARNING");
    expect(statusFromThreshold(96, t(85, 95))).toBe("CRITICAL");
    expect(statusFromThreshold(85, t(85, 95))).toBe("WARNING"); // boundary inclusive
  });
  it("null value → UNKNOWN; no threshold → NORMAL", () => {
    expect(statusFromThreshold(null, t(85, 95))).toBe("UNKNOWN");
    expect(statusFromThreshold(50)).toBe("NORMAL");
  });
  it("supports lower-worse direction", () => {
    expect(statusFromThreshold(10, t(20, 5, "LOWER_WORSE"))).toBe("WARNING");
    expect(statusFromThreshold(3, t(20, 5, "LOWER_WORSE"))).toBe("CRITICAL");
    expect(statusFromThreshold(30, t(20, 5, "LOWER_WORSE"))).toBe("NORMAL");
  });
});

describe("worst status rollup", () => {
  it("CRITICAL dominates; UNAVAILABLE does not mask a real CRITICAL", () => {
    expect(worstStatus("NORMAL", "WARNING", "CRITICAL")).toBe("CRITICAL");
    expect(worstStatus("NORMAL", "UNAVAILABLE")).toBe("UNAVAILABLE");
    expect(worstStatus("CRITICAL", "UNAVAILABLE")).toBe("CRITICAL");
    expect(worstStatus("NORMAL", "WATCH")).toBe("WATCH");
    expect(worstStatus()).toBe("NORMAL");
  });
});

describe("time windows", () => {
  const now = new Date("2026-09-21T12:00:00Z");
  it("resolves standard windows and defaults to 24h", () => {
    expect(resolveWindow("today", null, null, now).key).toBe("today");
    expect(resolveWindow("7d", null, null, now).key).toBe("7d");
    expect(resolveWindow(undefined, null, null, now).key).toBe("24h");
  });
  it("bounds custom ranges and rejects invalid ones", () => {
    expect(() => resolveWindow("custom", null, null, now)).toThrow();
    expect(() => resolveWindow("custom", "2026-09-21", "2026-09-20", now)).toThrow(); // from>=to
    expect(() => resolveWindow("custom", "2000-01-01", "2026-09-21", now)).toThrow(); // > max range
    expect(resolveWindow("custom", "2026-09-01", "2026-09-21", now).key).toBe("custom");
  });
});

describe("registry integrity", () => {
  it("every configurable threshold default has warning/critical/direction/unit", () => {
    for (const [k, d] of Object.entries(THRESHOLD_DEFAULTS)) {
      expect(typeof d.warning, k).toBe("number");
      expect(typeof d.critical, k).toBe("number");
      expect(["HIGHER_WORSE", "LOWER_WORSE"]).toContain(d.direction);
    }
  });
  it("drill-down allow-list is closed", () => {
    expect(isDrillKind("ward-occupancy")).toBe(true);
    expect(isDrillKind("arbitrary-table-dump")).toBe(false);
    expect(DRILLDOWN_KINDS.length).toBeGreaterThan(5);
  });
  it("all 14 domains are registered", () => {
    expect(ALL_SECTIONS.length).toBe(14);
  });
});
