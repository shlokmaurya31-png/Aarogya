import { describe, it, expect } from "vitest";
import { isStudyTransitionAllowed } from "./imagingStudyLifecycle";

describe("isStudyTransitionAllowed — imaging study state machine", () => {
  it("allows SCHEDULED -> ARRIVED (patient arrival)", () => {
    expect(isStudyTransitionAllowed("SCHEDULED", "ARRIVED")).toBe(true);
  });

  it("allows SCHEDULED -> CANCELLED", () => {
    expect(isStudyTransitionAllowed("SCHEDULED", "CANCELLED")).toBe(true);
  });

  it("allows ARRIVED -> IN_PROGRESS (technologist claims the study)", () => {
    expect(isStudyTransitionAllowed("ARRIVED", "IN_PROGRESS")).toBe(true);
  });

  it("allows IN_PROGRESS -> COMPLETED", () => {
    expect(isStudyTransitionAllowed("IN_PROGRESS", "COMPLETED")).toBe(true);
  });

  it("rejects SCHEDULED -> IN_PROGRESS (skipping arrival)", () => {
    expect(isStudyTransitionAllowed("SCHEDULED", "IN_PROGRESS")).toBe(false);
  });

  it("rejects ARRIVED -> COMPLETED (skipping in-progress)", () => {
    expect(isStudyTransitionAllowed("ARRIVED", "COMPLETED")).toBe(false);
  });

  it("rejects transitions out of a terminal COMPLETED state", () => {
    expect(isStudyTransitionAllowed("COMPLETED", "ARRIVED")).toBe(false);
  });

  it("rejects transitions out of a terminal CANCELLED state", () => {
    expect(isStudyTransitionAllowed("CANCELLED", "SCHEDULED")).toBe(false);
  });

  it("rejects IN_PROGRESS -> IN_PROGRESS (no self-transition/double-claim)", () => {
    expect(isStudyTransitionAllowed("IN_PROGRESS", "IN_PROGRESS")).toBe(false);
  });

  // Milestone E hardening — the cancel route already let staff select an
  // ARRIVED study (contrast allergy discovered, patient decompensates after
  // arriving), but this transition was previously missing, so cancel always
  // failed for that real, routine case.
  it("allows ARRIVED -> CANCELLED (imaging aborted after patient arrival)", () => {
    expect(isStudyTransitionAllowed("ARRIVED", "CANCELLED")).toBe(true);
  });

  it("still rejects ARRIVED -> COMPLETED (skipping in-progress, even with cancel now allowed)", () => {
    expect(isStudyTransitionAllowed("ARRIVED", "COMPLETED")).toBe(false);
  });
});
