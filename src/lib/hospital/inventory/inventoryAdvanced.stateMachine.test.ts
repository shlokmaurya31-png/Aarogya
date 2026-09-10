import { describe, it, expect } from "vitest";
import { isDepartmentRequestTransitionAllowed } from "./inventoryAdvanced";

/**
 * Phase B8 generic department-supply-request lifecycle. One request model for
 * every department; transitions must be single-path and terminal-safe so a
 * request can never be reserved/issued twice or resurrected after closure.
 */
describe("isDepartmentRequestTransitionAllowed — generic supply request", () => {
  it("allows REQUESTED -> APPROVED -> RESERVED -> ISSUED -> RECEIVED", () => {
    expect(isDepartmentRequestTransitionAllowed("REQUESTED", "APPROVED")).toBe(true);
    expect(isDepartmentRequestTransitionAllowed("APPROVED", "RESERVED")).toBe(true);
    expect(isDepartmentRequestTransitionAllowed("RESERVED", "ISSUED")).toBe(true);
    expect(isDepartmentRequestTransitionAllowed("ISSUED", "RECEIVED")).toBe(true);
  });
  it("allows approve-then-direct-issue (skipping an explicit reservation)", () => {
    expect(isDepartmentRequestTransitionAllowed("APPROVED", "ISSUED")).toBe(true);
  });
  it("rejects illegal/backwards transitions and mutation of terminal states", () => {
    expect(isDepartmentRequestTransitionAllowed("REQUESTED", "ISSUED")).toBe(false);
    expect(isDepartmentRequestTransitionAllowed("ISSUED", "APPROVED")).toBe(false);
    expect(isDepartmentRequestTransitionAllowed("RECEIVED", "ISSUED")).toBe(false);
    expect(isDepartmentRequestTransitionAllowed("REJECTED", "APPROVED")).toBe(false);
    expect(isDepartmentRequestTransitionAllowed("CANCELLED", "APPROVED")).toBe(false);
  });
});
