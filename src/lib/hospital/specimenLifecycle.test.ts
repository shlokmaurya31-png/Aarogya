import { describe, it, expect } from "vitest";
import { isSpecimenTransitionAllowed, generateAccessionNumber } from "./specimenLifecycle";

describe("isSpecimenTransitionAllowed — specimen state machine", () => {
  it("allows COLLECTION_PENDING -> COLLECTED", () => {
    expect(isSpecimenTransitionAllowed("COLLECTION_PENDING", "COLLECTED")).toBe(true);
  });

  it("allows COLLECTED -> RECEIVED", () => {
    expect(isSpecimenTransitionAllowed("COLLECTED", "RECEIVED")).toBe(true);
  });

  it("allows RECEIVED -> ACCEPTED", () => {
    expect(isSpecimenTransitionAllowed("RECEIVED", "ACCEPTED")).toBe(true);
  });

  it("allows RECEIVED -> REJECTED", () => {
    expect(isSpecimenTransitionAllowed("RECEIVED", "REJECTED")).toBe(true);
  });

  it("allows ACCEPTED -> RESULTED", () => {
    expect(isSpecimenTransitionAllowed("ACCEPTED", "RESULTED")).toBe(true);
  });

  it("rejects COLLECTION_PENDING -> REJECTED (must be received first)", () => {
    expect(isSpecimenTransitionAllowed("COLLECTION_PENDING", "REJECTED")).toBe(false);
  });

  it("rejects COLLECTED -> ACCEPTED (skipping receipt)", () => {
    expect(isSpecimenTransitionAllowed("COLLECTED", "ACCEPTED")).toBe(false);
  });

  it("rejects a terminal REJECTED specimen transitioning anywhere else directly", () => {
    expect(isSpecimenTransitionAllowed("REJECTED", "COLLECTION_PENDING")).toBe(false);
  });

  it("rejects RESULTED -> RESULTED (no double-resulting)", () => {
    expect(isSpecimenTransitionAllowed("RESULTED", "RESULTED")).toBe(false);
  });
});

describe("generateAccessionNumber", () => {
  it("produces a non-empty, LAB-prefixed string", () => {
    const n = generateAccessionNumber();
    expect(n.startsWith("LAB-")).toBe(true);
    expect(n.length).toBeGreaterThan(10);
  });

  it("produces distinct values across calls (collision-resistant, not guaranteed-unique)", () => {
    const a = generateAccessionNumber();
    const b = generateAccessionNumber();
    expect(a).not.toBe(b);
  });
});
