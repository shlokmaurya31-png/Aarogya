import { describe, it, expect } from "vitest";
import { isEncounterTransitionAllowed } from "./encounterStateMachine";

/**
 * Phase B5 ED disposition ↔ canonical encounter-state-machine mapping. The ED
 * layer never invents encounter states — it drives the canonical EncounterStatus
 * transitions. These assert the terminal mappings the ED disposition relies on
 * (admit -> ADMITTED; discharge/LAMA/DAMA -> DISCHARGED; LWBS/absconded from an
 * unseen encounter -> CANCELLED) are legal, and illegal ones are rejected.
 */
describe("ED disposition → canonical encounter transitions", () => {
  it("admit dispositions map to ADMITTED from an active ED status", () => {
    expect(isEncounterTransitionAllowed("REGISTERED", "ADMITTED")).toBe(true);
    expect(isEncounterTransitionAllowed("TRIAGED", "ADMITTED")).toBe(true);
    expect(isEncounterTransitionAllowed("IN_CONSULTATION", "ADMITTED")).toBe(true);
    expect(isEncounterTransitionAllowed("INVESTIGATING", "ADMITTED")).toBe(true);
  });

  it("discharge/LAMA/DAMA map to DISCHARGED once the patient has been seen", () => {
    expect(isEncounterTransitionAllowed("TRIAGED", "DISCHARGED")).toBe(true);
    expect(isEncounterTransitionAllowed("IN_CONSULTATION", "DISCHARGED")).toBe(true);
    expect(isEncounterTransitionAllowed("INVESTIGATING", "DISCHARGED")).toBe(true);
  });

  it("LWBS/absconded from a never-seen (REGISTERED) encounter fall back to CANCELLED, not DISCHARGED", () => {
    // A REGISTERED patient cannot be DISCHARGED directly — the ED disposition
    // service falls back to CANCELLED for LWBS/absconded, which IS legal.
    expect(isEncounterTransitionAllowed("REGISTERED", "DISCHARGED")).toBe(false);
    expect(isEncounterTransitionAllowed("REGISTERED", "CANCELLED")).toBe(true);
    expect(isEncounterTransitionAllowed("TRIAGED", "CANCELLED")).toBe(true);
  });

  it("a closed/terminal ED encounter cannot be resurrected or re-dispositioned", () => {
    expect(isEncounterTransitionAllowed("DISCHARGED", "IN_CONSULTATION")).toBe(false);
    expect(isEncounterTransitionAllowed("DISCHARGED", "ADMITTED")).toBe(false);
    expect(isEncounterTransitionAllowed("CANCELLED", "ADMITTED")).toBe(false);
    expect(isEncounterTransitionAllowed("CLOSED", "DISCHARGED")).toBe(false);
    // Only the terminal close-out is allowed.
    expect(isEncounterTransitionAllowed("DISCHARGED", "CLOSED")).toBe(true);
    expect(isEncounterTransitionAllowed("CANCELLED", "CLOSED")).toBe(true);
  });

  it("an admitted ED patient can only move on to DISCHARGED (not back to an ED status)", () => {
    expect(isEncounterTransitionAllowed("ADMITTED", "DISCHARGED")).toBe(true);
    expect(isEncounterTransitionAllowed("ADMITTED", "IN_CONSULTATION")).toBe(false);
    expect(isEncounterTransitionAllowed("ADMITTED", "TRIAGED")).toBe(false);
  });
});
