import { describe, it, expect } from "vitest";
import { isMedicationOrderTransitionAllowed } from "./medicationLifecycle";

describe("isMedicationOrderTransitionAllowed — medication order lifecycle (brief §16)", () => {
  it("allows the standard prescribe -> pharmacy -> dispense -> administer path", () => {
    expect(isMedicationOrderTransitionAllowed("DRAFT", "ORDERED")).toBe(true);
    expect(isMedicationOrderTransitionAllowed("ORDERED", "PHARMACY_REVIEW")).toBe(true);
    expect(isMedicationOrderTransitionAllowed("PHARMACY_REVIEW", "VERIFIED")).toBe(true);
    expect(isMedicationOrderTransitionAllowed("VERIFIED", "DISPENSED")).toBe(true);
    expect(isMedicationOrderTransitionAllowed("DISPENSED", "ACTIVE")).toBe(true);
    expect(isMedicationOrderTransitionAllowed("ACTIVE", "COMPLETED")).toBe(true);
  });

  it("allows a pharmacist to reject, hold, or request clarification from PHARMACY_REVIEW", () => {
    expect(isMedicationOrderTransitionAllowed("PHARMACY_REVIEW", "REJECTED")).toBe(true);
    expect(isMedicationOrderTransitionAllowed("PHARMACY_REVIEW", "HELD")).toBe(true);
  });

  it("allows a doctor to correct and resubmit a REJECTED or HELD order (brief Scenario D)", () => {
    expect(isMedicationOrderTransitionAllowed("REJECTED", "PHARMACY_REVIEW")).toBe(true);
    expect(isMedicationOrderTransitionAllowed("HELD", "PHARMACY_REVIEW")).toBe(true);
  });

  it("rejects administering/dispensing a CANCELLED or DISCONTINUED order — every terminal state is truly terminal", () => {
    expect(isMedicationOrderTransitionAllowed("CANCELLED", "ACTIVE")).toBe(false);
    expect(isMedicationOrderTransitionAllowed("DISCONTINUED", "ACTIVE")).toBe(false);
    expect(isMedicationOrderTransitionAllowed("COMPLETED", "ACTIVE")).toBe(false);
    expect(isMedicationOrderTransitionAllowed("CANCELLED", "CANCELLED")).toBe(false);
  });

  it("rejects skipping pharmacy review entirely", () => {
    expect(isMedicationOrderTransitionAllowed("ORDERED", "VERIFIED")).toBe(false);
    expect(isMedicationOrderTransitionAllowed("ORDERED", "DISPENSED")).toBe(false);
  });

  it("allows DISCONTINUED from any active non-terminal state (a doctor can stop a med at any stage)", () => {
    expect(isMedicationOrderTransitionAllowed("HELD", "DISCONTINUED")).toBe(true);
    expect(isMedicationOrderTransitionAllowed("VERIFIED", "DISCONTINUED")).toBe(true);
    expect(isMedicationOrderTransitionAllowed("DISPENSED", "DISCONTINUED")).toBe(true);
    expect(isMedicationOrderTransitionAllowed("ACTIVE", "DISCONTINUED")).toBe(true);
  });

  it("never allows a REJECTED order straight back to ACTIVE without going through pharmacy review again", () => {
    expect(isMedicationOrderTransitionAllowed("REJECTED", "ACTIVE")).toBe(false);
    expect(isMedicationOrderTransitionAllowed("REJECTED", "VERIFIED")).toBe(false);
  });
});
