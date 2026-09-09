import { describe, it, expect } from "vitest";
import { isExternalReferralTransitionAllowed, isQcReviewTransitionAllowed } from "./diagnosticsAdvanced";

/**
 * Phase B7 quality-management + external-lab state machines. QC/calibration
 * review and external-referral lifecycle must be single-path and terminal-safe
 * (a reviewed/rejected record is immutable; a referral cannot skip states).
 */
describe("isExternalReferralTransitionAllowed — external lab lifecycle", () => {
  it("allows DRAFT -> SENT -> RESULT_RECEIVED -> REVIEWED", () => {
    expect(isExternalReferralTransitionAllowed("DRAFT", "SENT")).toBe(true);
    expect(isExternalReferralTransitionAllowed("SENT", "RESULT_RECEIVED")).toBe(true);
    expect(isExternalReferralTransitionAllowed("RESULT_RECEIVED", "REVIEWED")).toBe(true);
  });
  it("allows cancellation only before a result is received", () => {
    expect(isExternalReferralTransitionAllowed("DRAFT", "CANCELLED")).toBe(true);
    expect(isExternalReferralTransitionAllowed("SENT", "CANCELLED")).toBe(true);
    expect(isExternalReferralTransitionAllowed("RESULT_RECEIVED", "CANCELLED")).toBe(false);
  });
  it("rejects skipping states and mutating terminal states", () => {
    expect(isExternalReferralTransitionAllowed("DRAFT", "RESULT_RECEIVED")).toBe(false);
    expect(isExternalReferralTransitionAllowed("DRAFT", "REVIEWED")).toBe(false);
    expect(isExternalReferralTransitionAllowed("REVIEWED", "SENT")).toBe(false);
    expect(isExternalReferralTransitionAllowed("CANCELLED", "SENT")).toBe(false);
  });
});

describe("isQcReviewTransitionAllowed — QC/calibration review", () => {
  it("allows PENDING -> REVIEWED and PENDING -> REJECTED", () => {
    expect(isQcReviewTransitionAllowed("PENDING", "REVIEWED")).toBe(true);
    expect(isQcReviewTransitionAllowed("PENDING", "REJECTED")).toBe(true);
  });
  it("makes a reviewed/rejected record terminal (immutable)", () => {
    expect(isQcReviewTransitionAllowed("REVIEWED", "PENDING")).toBe(false);
    expect(isQcReviewTransitionAllowed("REVIEWED", "REJECTED")).toBe(false);
    expect(isQcReviewTransitionAllowed("REJECTED", "REVIEWED")).toBe(false);
  });
});
