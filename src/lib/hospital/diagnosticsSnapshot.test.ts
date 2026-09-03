import { describe, it, expect } from "vitest";
import { mapToDiagnosticStatus } from "./diagnosticsSnapshot";
import { mapDiagnosticPriorityToOrderPriority } from "./diagnosticsLifecycle";

describe("mapToDiagnosticStatus — LAB", () => {
  it("maps ORDERED to ORDERED", () => {
    expect(mapToDiagnosticStatus({ domain: "LAB", orderStatus: "ORDERED" })).toBe("ORDERED");
  });

  it("maps COLLECTED (specimen collected, awaiting receipt/acceptance) to IN_PROGRESS", () => {
    expect(mapToDiagnosticStatus({ domain: "LAB", orderStatus: "COLLECTED" })).toBe("IN_PROGRESS");
  });

  it("maps IN_PROGRESS (specimen accepted, ready for result entry) to AWAITING_RESULT", () => {
    expect(mapToDiagnosticStatus({ domain: "LAB", orderStatus: "IN_PROGRESS" })).toBe("AWAITING_RESULT");
  });

  it("maps RESULTED with an ENTERED (unverified) result to AWAITING_VERIFICATION", () => {
    expect(mapToDiagnosticStatus({ domain: "LAB", orderStatus: "RESULTED", resultStatus: "ENTERED" })).toBe("AWAITING_VERIFICATION");
  });

  it("maps RESULTED with a VERIFIED result to COMPLETED", () => {
    expect(mapToDiagnosticStatus({ domain: "LAB", orderStatus: "RESULTED", resultStatus: "VERIFIED" })).toBe("COMPLETED");
  });

  it("maps CANCELLED to CANCELLED", () => {
    expect(mapToDiagnosticStatus({ domain: "LAB", orderStatus: "CANCELLED" })).toBe("CANCELLED");
  });

  it("an unacknowledged critical result always maps to CRITICAL, regardless of underlying status", () => {
    expect(mapToDiagnosticStatus({ domain: "LAB", orderStatus: "RESULTED", resultStatus: "VERIFIED", isCritical: true })).toBe("CRITICAL");
  });
});

describe("mapToDiagnosticStatus — RADIOLOGY", () => {
  it("maps ORDERED to ORDERED", () => {
    expect(mapToDiagnosticStatus({ domain: "RADIOLOGY", orderStatus: "ORDERED" })).toBe("ORDERED");
  });

  it("maps SCHEDULED with a SCHEDULED study sub-status to SCHEDULED", () => {
    expect(mapToDiagnosticStatus({ domain: "RADIOLOGY", orderStatus: "SCHEDULED", subStatus: "SCHEDULED" })).toBe("SCHEDULED");
  });

  it("maps SCHEDULED with an ARRIVED/IN_PROGRESS study sub-status to IN_PROGRESS", () => {
    expect(mapToDiagnosticStatus({ domain: "RADIOLOGY", orderStatus: "SCHEDULED", subStatus: "ARRIVED" })).toBe("IN_PROGRESS");
    expect(mapToDiagnosticStatus({ domain: "RADIOLOGY", orderStatus: "SCHEDULED", subStatus: "IN_PROGRESS" })).toBe("IN_PROGRESS");
  });

  it("maps ACQUIRED (study done, report not yet entered) to AWAITING_RESULT", () => {
    expect(mapToDiagnosticStatus({ domain: "RADIOLOGY", orderStatus: "ACQUIRED" })).toBe("AWAITING_RESULT");
  });

  it("maps REPORTED with an ENTERED (unverified) report to AWAITING_VERIFICATION", () => {
    expect(mapToDiagnosticStatus({ domain: "RADIOLOGY", orderStatus: "REPORTED", resultStatus: "ENTERED" })).toBe("AWAITING_VERIFICATION");
  });

  it("maps REPORTED with a VERIFIED report to COMPLETED", () => {
    expect(mapToDiagnosticStatus({ domain: "RADIOLOGY", orderStatus: "REPORTED", resultStatus: "VERIFIED" })).toBe("COMPLETED");
  });

  it("an unacknowledged critical finding always maps to CRITICAL, regardless of underlying status", () => {
    expect(mapToDiagnosticStatus({ domain: "RADIOLOGY", orderStatus: "REPORTED", resultStatus: "VERIFIED", isCritical: true })).toBe("CRITICAL");
  });
});

// Phase 4 Milestone D (brief §6) — explicit per-domain assertions that the
// SAME shared priority-mapping function (already introduced in Milestone A)
// behaves identically for Lab and Radiology, since both domains' priority
// fields are the same free-text vocabulary and must not diverge.
describe("mapDiagnosticPriorityToOrderPriority — consistent across Lab and Radiology", () => {
  it("maps STAT to EMERGENCY for a lab-style priority string", () => {
    expect(mapDiagnosticPriorityToOrderPriority("STAT")).toBe("EMERGENCY");
  });

  it("maps STAT to EMERGENCY for a radiology-style priority string (same vocabulary, same function)", () => {
    const radiologyPriority = "STAT";
    expect(mapDiagnosticPriorityToOrderPriority(radiologyPriority)).toBe("EMERGENCY");
  });

  it("maps URGENT identically for both domains", () => {
    expect(mapDiagnosticPriorityToOrderPriority("URGENT")).toBe(mapDiagnosticPriorityToOrderPriority("URGENT"));
    expect(mapDiagnosticPriorityToOrderPriority("URGENT")).toBe("URGENT");
  });

  it("defaults ROUTINE identically for both domains", () => {
    expect(mapDiagnosticPriorityToOrderPriority("ROUTINE")).toBe("ROUTINE");
  });
});
