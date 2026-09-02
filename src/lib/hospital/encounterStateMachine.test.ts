import { describe, it, expect } from "vitest";
import { isEncounterTransitionAllowed } from "./encounterStateMachine";

describe("isEncounterTransitionAllowed — encounter lifecycle (brief §13)", () => {
  it("allows the standard ED path: REGISTERED -> TRIAGED -> IN_CONSULTATION -> DISCHARGED", () => {
    expect(isEncounterTransitionAllowed("REGISTERED", "TRIAGED")).toBe(true);
    expect(isEncounterTransitionAllowed("TRIAGED", "IN_CONSULTATION")).toBe(true);
    expect(isEncounterTransitionAllowed("IN_CONSULTATION", "DISCHARGED")).toBe(true);
  });

  it("allows direct/emergency admission from REGISTERED or TRIAGED", () => {
    expect(isEncounterTransitionAllowed("REGISTERED", "ADMITTED")).toBe(true);
    expect(isEncounterTransitionAllowed("TRIAGED", "ADMITTED")).toBe(true);
  });

  it("rejects CLOSED -> IN_PROGRESS-style resurrection (brief §13's explicit invalid example)", () => {
    expect(isEncounterTransitionAllowed("CLOSED", "IN_CONSULTATION")).toBe(false);
    expect(isEncounterTransitionAllowed("CLOSED", "REGISTERED")).toBe(false);
  });

  it("rejects skipping straight from DISCHARGED back to an active state", () => {
    expect(isEncounterTransitionAllowed("DISCHARGED", "IN_CONSULTATION")).toBe(false);
    expect(isEncounterTransitionAllowed("DISCHARGED", "ADMITTED")).toBe(false);
  });

  it("only allows DISCHARGED -> CLOSED and CANCELLED -> CLOSED as terminal transitions", () => {
    expect(isEncounterTransitionAllowed("DISCHARGED", "CLOSED")).toBe(true);
    expect(isEncounterTransitionAllowed("CANCELLED", "CLOSED")).toBe(true);
    expect(isEncounterTransitionAllowed("CLOSED", "CLOSED")).toBe(false);
  });

  it("allows cancellation from any pre-admission active state", () => {
    expect(isEncounterTransitionAllowed("REGISTERED", "CANCELLED")).toBe(true);
    expect(isEncounterTransitionAllowed("TRIAGED", "CANCELLED")).toBe(true);
    expect(isEncounterTransitionAllowed("IN_CONSULTATION", "CANCELLED")).toBe(true);
    expect(isEncounterTransitionAllowed("INVESTIGATING", "CANCELLED")).toBe(true);
  });

  it("does not allow cancelling an already-admitted encounter (must go through discharge instead)", () => {
    expect(isEncounterTransitionAllowed("ADMITTED", "CANCELLED")).toBe(false);
  });
});
