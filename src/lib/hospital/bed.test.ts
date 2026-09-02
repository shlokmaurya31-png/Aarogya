import { describe, it, expect } from "vitest";
import { isTransitionAllowed } from "./bed";

describe("isTransitionAllowed — bed state machine", () => {
  it("allows AVAILABLE -> OCCUPIED (admission)", () => {
    expect(isTransitionAllowed("AVAILABLE", "OCCUPIED")).toBe(true);
  });

  it("allows OCCUPIED -> CLEANING (discharge)", () => {
    expect(isTransitionAllowed("OCCUPIED", "CLEANING")).toBe(true);
  });

  it("allows CLEANING -> AVAILABLE (housekeeping complete)", () => {
    expect(isTransitionAllowed("CLEANING", "AVAILABLE")).toBe(true);
  });

  it("rejects AVAILABLE -> TRANSFER_PENDING (a bed cannot enter transfer without first being occupied)", () => {
    expect(isTransitionAllowed("AVAILABLE", "TRANSFER_PENDING")).toBe(false);
  });

  it("rejects MAINTENANCE -> OCCUPIED directly (must go through AVAILABLE first)", () => {
    expect(isTransitionAllowed("MAINTENANCE", "OCCUPIED")).toBe(false);
  });

  it("rejects a bed transitioning to its own current status via an unlisted path", () => {
    expect(isTransitionAllowed("BLOCKED", "BLOCKED")).toBe(false);
  });
});
