import { describe, it, expect } from "vitest";
import { computeQueuePriority } from "./queue";

describe("computeQueuePriority — deterministic queue priority (brief §9)", () => {
  const now = new Date();

  it("gives a routine OPD walk-in a standard score", () => {
    const { score, reason } = computeQueuePriority({ enteredAt: now });
    expect(score).toBe(100);
    expect(reason).toBe("standard");
  });

  it("prioritizes ED/emergency arrivals over routine OPD", () => {
    const opd = computeQueuePriority({ enteredAt: now, encounterType: "OPD" });
    const ed = computeQueuePriority({ enteredAt: now, encounterType: "ED" });
    expect(ed.score).toBeLessThan(opd.score);
  });

  it("a recorded triage acuity dominates and can only make the entry more urgent", () => {
    const { score, reason } = computeQueuePriority({ enteredAt: now, encounterType: "ED", triageAcuity: 1 });
    expect(score).toBeLessThanOrEqual(10);
    expect(reason).toContain("triage acuity 1");
  });

  it("EMERGENCY priority outranks URGENT, which outranks ROUTINE", () => {
    const routine = computeQueuePriority({ enteredAt: now, requestedPriority: "ROUTINE" });
    const urgent = computeQueuePriority({ enteredAt: now, requestedPriority: "URGENT" });
    const emergency = computeQueuePriority({ enteredAt: now, requestedPriority: "EMERGENCY" });
    expect(emergency.score).toBeLessThan(urgent.score);
    expect(urgent.score).toBeLessThan(routine.score);
  });

  it("never silently reorders without a recorded reason — reason is always populated when a factor applies", () => {
    const { reason } = computeQueuePriority({ enteredAt: now, requestedPriority: "URGENT", ageYears: 1 });
    expect(reason).toContain("marked URGENT");
    expect(reason).toContain("age-based priority");
  });

  it("applies an anti-starvation bonus for a long wait, capped at 20", () => {
    const longWait = new Date(Date.now() - 5 * 3_600_000); // 5 hours ago
    const { score, reason } = computeQueuePriority({ enteredAt: longWait });
    expect(score).toBeLessThan(100);
    expect(reason).toContain("long wait");
  });

  it("score is never below 1", () => {
    const { score } = computeQueuePriority({ enteredAt: now, requestedPriority: "EMERGENCY", encounterType: "ED", triageAcuity: 1 });
    expect(score).toBeGreaterThanOrEqual(1);
  });
});
