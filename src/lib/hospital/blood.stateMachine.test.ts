import { describe, it, expect } from "vitest";
import { isUnitTransitionAllowed } from "./blood";

/**
 * Phase B4 blood-unit state-machine safety (brief §56). These are the explicit
 * illegal transitions the brief demands be rejected — a serialized unit's status
 * is the concurrency-control point, so an illegal precondition must never pass.
 */
describe("isUnitTransitionAllowed — blood unit lifecycle", () => {
  it("allows the standard happy path: QUARANTINED -> AVAILABLE -> RESERVED -> ISSUED -> TRANSFUSING -> TRANSFUSED", () => {
    expect(isUnitTransitionAllowed("QUARANTINED", "AVAILABLE")).toBe(true);
    expect(isUnitTransitionAllowed("AVAILABLE", "RESERVED")).toBe(true);
    expect(isUnitTransitionAllowed("RESERVED", "ISSUED")).toBe(true);
    expect(isUnitTransitionAllowed("ISSUED", "TRANSFUSING")).toBe(true);
    expect(isUnitTransitionAllowed("TRANSFUSING", "TRANSFUSED")).toBe(true);
  });

  it("allows direct issue of an AVAILABLE unit (emergency/no-reservation path)", () => {
    expect(isUnitTransitionAllowed("AVAILABLE", "ISSUED")).toBe(true);
  });

  it("rejects resurrecting a spent unit back to AVAILABLE (brief §56)", () => {
    expect(isUnitTransitionAllowed("TRANSFUSED", "AVAILABLE")).toBe(false);
    expect(isUnitTransitionAllowed("WASTED", "AVAILABLE")).toBe(false);
    expect(isUnitTransitionAllowed("DISCARDED", "AVAILABLE")).toBe(false);
  });

  it("rejects issuing a quarantined unit (brief §11, §56)", () => {
    expect(isUnitTransitionAllowed("QUARANTINED", "ISSUED")).toBe(false);
    expect(isUnitTransitionAllowed("QUARANTINED", "RESERVED")).toBe(false);
  });

  it("rejects re-completing / rewinding a transfused unit", () => {
    expect(isUnitTransitionAllowed("TRANSFUSED", "TRANSFUSING")).toBe(false);
    expect(isUnitTransitionAllowed("TRANSFUSED", "ISSUED")).toBe(false);
  });

  it("wasted/discarded are terminal", () => {
    expect(isUnitTransitionAllowed("WASTED", "ISSUED")).toBe(false);
    expect(isUnitTransitionAllowed("WASTED", "QUARANTINED")).toBe(false);
    expect(isUnitTransitionAllowed("DISCARDED", "AVAILABLE")).toBe(false);
  });

  it("a returned unit never becomes AVAILABLE implicitly — only via an explicit release transition", () => {
    // The transition itself is permitted, but returnUnit() sets RETURNED (never
    // AVAILABLE); re-availability is a separate, explicit release action.
    expect(isUnitTransitionAllowed("ISSUED", "RETURNED")).toBe(true);
    expect(isUnitTransitionAllowed("RETURNED", "AVAILABLE")).toBe(true);
    expect(isUnitTransitionAllowed("RETURNED", "ISSUED")).toBe(false);
  });

  it("a reserved unit can be released back to AVAILABLE or consumed by issue, but not skipped to TRANSFUSED", () => {
    expect(isUnitTransitionAllowed("RESERVED", "AVAILABLE")).toBe(true);
    expect(isUnitTransitionAllowed("RESERVED", "ISSUED")).toBe(true);
    expect(isUnitTransitionAllowed("RESERVED", "TRANSFUSED")).toBe(false);
  });

  it("a unit under transfusion can be quarantined (reaction path) but not returned to stock", () => {
    expect(isUnitTransitionAllowed("TRANSFUSING", "QUARANTINED")).toBe(true);
    expect(isUnitTransitionAllowed("TRANSFUSING", "AVAILABLE")).toBe(false);
    expect(isUnitTransitionAllowed("TRANSFUSING", "RESERVED")).toBe(false);
  });
});
