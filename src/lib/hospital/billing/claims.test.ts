import { describe, it, expect } from "vitest";
import { isClaimTransitionAllowed } from "./claims";

describe("isClaimTransitionAllowed — claim lifecycle", () => {
  it("allows DRAFT -> SUBMITTED", () => {
    expect(isClaimTransitionAllowed("DRAFT", "SUBMITTED")).toBe(true);
  });

  it("rejects DRAFT -> APPROVED (skipping submission and review)", () => {
    expect(isClaimTransitionAllowed("DRAFT", "APPROVED")).toBe(false);
  });

  it("allows SUBMITTED -> UNDER_REVIEW", () => {
    expect(isClaimTransitionAllowed("SUBMITTED", "UNDER_REVIEW")).toBe(true);
  });

  it("allows SUBMITTED -> REJECTED directly (payer can reject without a review step)", () => {
    expect(isClaimTransitionAllowed("SUBMITTED", "REJECTED")).toBe(true);
  });

  it("allows UNDER_REVIEW -> APPROVED, PARTIALLY_APPROVED, or REJECTED", () => {
    expect(isClaimTransitionAllowed("UNDER_REVIEW", "APPROVED")).toBe(true);
    expect(isClaimTransitionAllowed("UNDER_REVIEW", "PARTIALLY_APPROVED")).toBe(true);
    expect(isClaimTransitionAllowed("UNDER_REVIEW", "REJECTED")).toBe(true);
  });

  it("allows APPROVED -> SETTLED and PARTIALLY_APPROVED -> SETTLED", () => {
    expect(isClaimTransitionAllowed("APPROVED", "SETTLED")).toBe(true);
    expect(isClaimTransitionAllowed("PARTIALLY_APPROVED", "SETTLED")).toBe(true);
  });

  it("allows REJECTED -> CLOSED and SETTLED -> CLOSED", () => {
    expect(isClaimTransitionAllowed("REJECTED", "CLOSED")).toBe(true);
    expect(isClaimTransitionAllowed("SETTLED", "CLOSED")).toBe(true);
  });

  it("rejects any transition out of a terminal CLOSED state", () => {
    expect(isClaimTransitionAllowed("CLOSED", "DRAFT")).toBe(false);
  });

  it("rejects re-submitting an already-submitted claim (no duplicate submission)", () => {
    expect(isClaimTransitionAllowed("SUBMITTED", "SUBMITTED")).toBe(false);
  });
});
