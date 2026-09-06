import { describe, it, expect } from "vitest";
import { isRefundTransitionAllowed } from "./refunds";

describe("isRefundTransitionAllowed — refund state machine", () => {
  it("allows REQUESTED -> APPROVED", () => {
    expect(isRefundTransitionAllowed("REQUESTED", "APPROVED")).toBe(true);
  });

  it("allows REQUESTED -> REJECTED", () => {
    expect(isRefundTransitionAllowed("REQUESTED", "REJECTED")).toBe(true);
  });

  it("allows APPROVED -> COMPLETED", () => {
    expect(isRefundTransitionAllowed("APPROVED", "COMPLETED")).toBe(true);
  });

  it("rejects REQUESTED -> COMPLETED (skipping approval)", () => {
    expect(isRefundTransitionAllowed("REQUESTED", "COMPLETED")).toBe(false);
  });

  it("rejects any transition out of a terminal COMPLETED state (no double-completion)", () => {
    expect(isRefundTransitionAllowed("COMPLETED", "APPROVED")).toBe(false);
  });

  it("rejects any transition out of a terminal REJECTED state", () => {
    expect(isRefundTransitionAllowed("REJECTED", "APPROVED")).toBe(false);
  });
});
