import { describe, it, expect } from "vitest";
import { isLabOrderTransitionAllowed, isImagingOrderTransitionAllowed, mapDiagnosticPriorityToOrderPriority } from "./diagnosticsLifecycle";

describe("isLabOrderTransitionAllowed — LabOrder state machine (Milestone B specimen-driven flow)", () => {
  it("allows ORDERED -> COLLECTED (specimen collected)", () => {
    expect(isLabOrderTransitionAllowed("ORDERED", "COLLECTED")).toBe(true);
  });

  it("allows COLLECTED -> IN_PROGRESS (specimen accepted)", () => {
    expect(isLabOrderTransitionAllowed("COLLECTED", "IN_PROGRESS")).toBe(true);
  });

  it("allows IN_PROGRESS -> RESULTED (result entered)", () => {
    expect(isLabOrderTransitionAllowed("IN_PROGRESS", "RESULTED")).toBe(true);
  });

  it("rejects ORDERED -> RESULTED directly (specimen workflow can no longer be skipped)", () => {
    expect(isLabOrderTransitionAllowed("ORDERED", "RESULTED")).toBe(false);
  });

  it("rejects RESULTED -> RESULTED (no double-resulting at the order level)", () => {
    expect(isLabOrderTransitionAllowed("RESULTED", "RESULTED")).toBe(false);
  });
});

describe("isImagingOrderTransitionAllowed — ImagingOrder state machine (Milestone C scheduling-driven flow)", () => {
  it("allows ORDERED -> SCHEDULED (study scheduled)", () => {
    expect(isImagingOrderTransitionAllowed("ORDERED", "SCHEDULED")).toBe(true);
  });

  it("allows SCHEDULED -> ACQUIRED (study completed)", () => {
    expect(isImagingOrderTransitionAllowed("SCHEDULED", "ACQUIRED")).toBe(true);
  });

  it("allows ACQUIRED -> REPORTED (report entered)", () => {
    expect(isImagingOrderTransitionAllowed("ACQUIRED", "REPORTED")).toBe(true);
  });

  it("rejects ORDERED -> ACQUIRED (skipping scheduling)", () => {
    expect(isImagingOrderTransitionAllowed("ORDERED", "ACQUIRED")).toBe(false);
  });

  it("rejects ORDERED -> REPORTED directly (the study workflow can no longer be skipped)", () => {
    expect(isImagingOrderTransitionAllowed("ORDERED", "REPORTED")).toBe(false);
  });

  it("rejects REPORTED -> REPORTED (no double-reporting at the order level)", () => {
    expect(isImagingOrderTransitionAllowed("REPORTED", "REPORTED")).toBe(false);
  });
});

describe("mapDiagnosticPriorityToOrderPriority", () => {
  it("maps STAT to EMERGENCY", () => {
    expect(mapDiagnosticPriorityToOrderPriority("STAT")).toBe("EMERGENCY");
  });

  it("maps URGENT to URGENT", () => {
    expect(mapDiagnosticPriorityToOrderPriority("URGENT")).toBe("URGENT");
  });

  it("defaults anything else to ROUTINE", () => {
    expect(mapDiagnosticPriorityToOrderPriority("ROUTINE")).toBe("ROUTINE");
    expect(mapDiagnosticPriorityToOrderPriority(undefined)).toBe("ROUTINE");
    expect(mapDiagnosticPriorityToOrderPriority(null)).toBe("ROUTINE");
  });
});
