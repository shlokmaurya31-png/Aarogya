import { describe, it, expect } from "vitest";
import {
  isTransitionAllowed, INCIDENT_TRANSITIONS, CAPA_TRANSITIONS, AUDIT_TRANSITIONS,
  INCIDENT_SEVERITIES, INCIDENT_CATEGORIES,
} from "./shared";

/**
 * Phase B10 quality / patient-safety state machines. Phase B10 shipped without
 * any unit coverage; these lock in the lifecycle rules the service relies on so
 * a future edit to the transition maps cannot silently allow a closed incident
 * to be rewound or a CAPA to skip verification.
 */
describe("quality incident lifecycle", () => {
  it("follows REPORTED->TRIAGED->UNDER_INVESTIGATION->ACTION_REQUIRED->RESOLVED->CLOSED", () => {
    expect(isTransitionAllowed(INCIDENT_TRANSITIONS, "REPORTED", "TRIAGED")).toBe(true);
    expect(isTransitionAllowed(INCIDENT_TRANSITIONS, "TRIAGED", "UNDER_INVESTIGATION")).toBe(true);
    expect(isTransitionAllowed(INCIDENT_TRANSITIONS, "UNDER_INVESTIGATION", "ACTION_REQUIRED")).toBe(true);
    expect(isTransitionAllowed(INCIDENT_TRANSITIONS, "ACTION_REQUIRED", "RESOLVED")).toBe(true);
    expect(isTransitionAllowed(INCIDENT_TRANSITIONS, "RESOLVED", "CLOSED")).toBe(true);
  });

  it("lets a resolved incident go back under investigation before closure", () => {
    expect(isTransitionAllowed(INCIDENT_TRANSITIONS, "RESOLVED", "UNDER_INVESTIGATION")).toBe(true);
  });

  it("refuses to skip triage straight to closure", () => {
    expect(isTransitionAllowed(INCIDENT_TRANSITIONS, "REPORTED", "CLOSED")).toBe(false);
    expect(isTransitionAllowed(INCIDENT_TRANSITIONS, "REPORTED", "RESOLVED")).toBe(false);
  });

  it("treats CLOSED as terminal for ordinary transitions (reopen is a separate authorized path)", () => {
    expect(INCIDENT_TRANSITIONS.CLOSED).toEqual([]);
    expect(isTransitionAllowed(INCIDENT_TRANSITIONS, "CLOSED", "UNDER_INVESTIGATION")).toBe(false);
    expect(isTransitionAllowed(INCIDENT_TRANSITIONS, "CLOSED", "TRIAGED")).toBe(false);
  });

  it("treats CANCELLED as terminal", () => {
    expect(isTransitionAllowed(INCIDENT_TRANSITIONS, "CANCELLED", "TRIAGED")).toBe(false);
    expect(isTransitionAllowed(INCIDENT_TRANSITIONS, "CANCELLED", "REPORTED")).toBe(false);
  });

  it("rejects an unknown source or target state rather than defaulting to allow", () => {
    expect(isTransitionAllowed(INCIDENT_TRANSITIONS, "NOT_A_STATE", "TRIAGED")).toBe(false);
    expect(isTransitionAllowed(INCIDENT_TRANSITIONS, "REPORTED", "NOT_A_STATE")).toBe(false);
  });
});

describe("CAPA lifecycle", () => {
  it("follows OPEN->IN_PROGRESS->COMPLETED->VERIFIED->CLOSED", () => {
    expect(isTransitionAllowed(CAPA_TRANSITIONS, "OPEN", "IN_PROGRESS")).toBe(true);
    expect(isTransitionAllowed(CAPA_TRANSITIONS, "IN_PROGRESS", "COMPLETED")).toBe(true);
    expect(isTransitionAllowed(CAPA_TRANSITIONS, "COMPLETED", "VERIFIED")).toBe(true);
    expect(isTransitionAllowed(CAPA_TRANSITIONS, "VERIFIED", "CLOSED")).toBe(true);
  });

  it("cannot close without passing through verification", () => {
    expect(isTransitionAllowed(CAPA_TRANSITIONS, "COMPLETED", "CLOSED")).toBe(false);
    expect(isTransitionAllowed(CAPA_TRANSITIONS, "IN_PROGRESS", "VERIFIED")).toBe(false);
  });

  it("cannot be cancelled once verified or closed", () => {
    expect(isTransitionAllowed(CAPA_TRANSITIONS, "VERIFIED", "CANCELLED")).toBe(false);
    expect(isTransitionAllowed(CAPA_TRANSITIONS, "CLOSED", "CANCELLED")).toBe(false);
  });
});

describe("internal audit lifecycle", () => {
  it("follows PLANNED->IN_PROGRESS->COMPLETED->CLOSED", () => {
    expect(isTransitionAllowed(AUDIT_TRANSITIONS, "PLANNED", "IN_PROGRESS")).toBe(true);
    expect(isTransitionAllowed(AUDIT_TRANSITIONS, "IN_PROGRESS", "COMPLETED")).toBe(true);
    expect(isTransitionAllowed(AUDIT_TRANSITIONS, "COMPLETED", "CLOSED")).toBe(true);
  });

  it("cannot reopen a closed audit or jump past execution", () => {
    expect(isTransitionAllowed(AUDIT_TRANSITIONS, "CLOSED", "IN_PROGRESS")).toBe(false);
    expect(isTransitionAllowed(AUDIT_TRANSITIONS, "PLANNED", "COMPLETED")).toBe(false);
  });
});

describe("documentary vocabularies", () => {
  it("keeps severity and category closed sets so a client cannot invent values", () => {
    expect(INCIDENT_SEVERITIES).toContain("CRITICAL");
    expect(INCIDENT_SEVERITIES).not.toContain("CATASTROPHIC");
    expect(INCIDENT_CATEGORIES).toContain("TRANSFUSION");
    expect(INCIDENT_CATEGORIES).toContain("MEDICATION");
    expect(INCIDENT_CATEGORIES).not.toContain("ARBITRARY");
  });
});
