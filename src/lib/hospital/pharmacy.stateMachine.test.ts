import { describe, it, expect } from "vitest";
import { isPharmacyRequestTransitionAllowed } from "./pharmacy";
import { isLotEligible } from "./inventory/fefo";

/**
 * Phase B6 pharmacy state-machine + FEFO-eligibility safety. Ward-request
 * lifecycle transitions must be single-path and terminal-safe; FEFO eligibility
 * must reject expired/quarantined/recalled/insufficient stock (the deterministic
 * rule the pharmacy dispense/reserve paths rely on — no invented logic).
 */
describe("isPharmacyRequestTransitionAllowed — ward request lifecycle", () => {
  it("allows the happy path REQUESTED -> APPROVED -> RESERVED -> ISSUED -> RECEIVED", () => {
    expect(isPharmacyRequestTransitionAllowed("REQUESTED", "APPROVED")).toBe(true);
    expect(isPharmacyRequestTransitionAllowed("APPROVED", "RESERVED")).toBe(true);
    expect(isPharmacyRequestTransitionAllowed("RESERVED", "ISSUED")).toBe(true);
    expect(isPharmacyRequestTransitionAllowed("ISSUED", "RECEIVED")).toBe(true);
  });

  it("allows approve-then-direct-issue (skipping an explicit reservation)", () => {
    expect(isPharmacyRequestTransitionAllowed("APPROVED", "ISSUED")).toBe(true);
  });

  it("rejects illegal / backwards transitions and mutation of terminal states", () => {
    expect(isPharmacyRequestTransitionAllowed("REQUESTED", "ISSUED")).toBe(false);
    expect(isPharmacyRequestTransitionAllowed("ISSUED", "APPROVED")).toBe(false);
    expect(isPharmacyRequestTransitionAllowed("RECEIVED", "ISSUED")).toBe(false);
    expect(isPharmacyRequestTransitionAllowed("REJECTED", "APPROVED")).toBe(false);
    expect(isPharmacyRequestTransitionAllowed("CANCELLED", "APPROVED")).toBe(false);
  });
});

describe("isLotEligible — dispensing eligibility gate (deterministic)", () => {
  const future = new Date(Date.now() + 90 * 24 * 3600_000);
  const past = new Date(Date.now() - 1000);
  it("accepts an ACTIVE, non-expired lot with enough available", () => {
    expect(isLotEligible({ lotId: "l1", lotStatus: "ACTIVE", expiresAt: future, onHandQty: 10, reservedQty: 2 }, 5)).toBe(true);
  });
  it("rejects expired, quarantined, and recalled lots even with stock", () => {
    expect(isLotEligible({ lotId: "l1", lotStatus: "ACTIVE", expiresAt: past, onHandQty: 10, reservedQty: 0 }, 1)).toBe(false);
    expect(isLotEligible({ lotId: "l1", lotStatus: "QUARANTINED", expiresAt: future, onHandQty: 10, reservedQty: 0 }, 1)).toBe(false);
    expect(isLotEligible({ lotId: "l1", lotStatus: "RECALLED", expiresAt: future, onHandQty: 10, reservedQty: 0 }, 1)).toBe(false);
    expect(isLotEligible({ lotId: "l1", lotStatus: "EXPIRED", expiresAt: future, onHandQty: 10, reservedQty: 0 }, 1)).toBe(false);
  });
  it("rejects when available (on-hand minus reserved) is insufficient", () => {
    expect(isLotEligible({ lotId: "l1", lotStatus: "ACTIVE", expiresAt: future, onHandQty: 10, reservedQty: 8 }, 5)).toBe(false);
  });
});
