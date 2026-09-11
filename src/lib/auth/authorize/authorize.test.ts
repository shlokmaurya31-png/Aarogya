import { describe, it, expect } from "vitest";
import { getActionPolicy, listActionPolicies, relationshipSatisfies, ACTION_POLICIES } from "./policies";
import { deny, allow, PURPOSES, DATA_CLASSES, RELATIONSHIPS, DECISIONS } from "./types";
import { AuthorizationDeniedError, isAuthorizationDenied } from "./errors";
import {
  EMERGENCY_CONTEXTS, MIN_REASON_LENGTH, MAX_DURATION_MS, DEFAULT_DURATION_MS,
} from "./breakGlass";
import {
  PRIVACY_REQUEST_TYPES, PRIVACY_TRANSITIONS, isPrivacyTransitionAllowed, describeRetention,
} from "./privacy";
import { unconfiguredMfaProvider, getMfaProvider } from "./sessionControl";

/**
 * Phase C4 — policy shape, relationship ranking, and the honesty invariants.
 *
 * These run without a database because they pin the RULES. The runtime
 * behaviour of the engine against real data is covered by
 * scripts/verify-postgres-trust-layer.ts.
 */

describe("policy registry", () => {
  it("denies an action that has no policy", () => {
    expect(getActionPolicy("nonexistent.action")).toBeNull();
  });

  it("gives every policy a data class and a description", () => {
    for (const { action, policy } of listActionPolicies()) {
      expect(DATA_CLASSES).toContain(policy.dataClass);
      expect(policy.description.length, `${action} needs a description`).toBeGreaterThan(10);
    }
  });

  it("only references purposes from the declared vocabulary", () => {
    for (const { policy } of listActionPolicies()) {
      for (const p of policy.allowedPurposes ?? []) expect(PURPOSES).toContain(p);
    }
  });

  it("only references relationships from the declared vocabulary", () => {
    for (const { policy } of listActionPolicies()) {
      if (policy.minimumRelationship) expect(RELATIONSHIPS).toContain(policy.minimumRelationship);
    }
  });
});

describe("the invariants that keep break-glass from becoming a backdoor", () => {
  it("NEVER allows break-glass on an external disclosure action", () => {
    // An emergency justifies reading a chart. It does not justify transmitting
    // a record to a third party without the patient's agreement.
    for (const action of ["patient.export.fhir", "exchange.request", "exchange.authorize", "billing.export"]) {
      expect(ACTION_POLICIES[action].breakGlassAllowed, `${action} must not be break-glass-able`).toBe(false);
    }
  });

  it("never allows break-glass on a security or administrative action", () => {
    for (const action of [
      "breakglass.activate", "breakglass.review", "audit.read.facility",
      "audit.read.platform", "credential.verify", "privilege.grant",
      "privacy.request.create", "privacy.request.review", "identity.external.link",
    ]) {
      expect(ACTION_POLICIES[action].breakGlassAllowed, `${action} must not be break-glass-able`).toBe(false);
    }
  });

  it("allows break-glass only on read-oriented clinical access", () => {
    const allowed = listActionPolicies().filter((x) => x.policy.breakGlassAllowed).map((x) => x.action);
    expect(allowed.sort()).toEqual([
      "document.read", "document.read.restricted", "patient.read", "patient.timeline.read",
    ]);
  });

  it("requires consent on every disclosure action", () => {
    for (const action of ["patient.export.fhir", "exchange.request", "exchange.authorize", "billing.export"]) {
      expect(ACTION_POLICIES[action].requireConsent, `${action} must require consent`).toBe(true);
    }
  });

  it("does NOT require consent for ordinary in-facility clinical reads", () => {
    // Consent is a disclosure control, not a substitute for authorization.
    // Demanding it for routine care would be both wrong and unusable.
    for (const action of ["patient.read", "patient.timeline.read", "document.read"]) {
      expect(ACTION_POLICIES[action].requireConsent ?? false).toBe(false);
    }
  });

  it("treats a RESTRICTED document as needing a genuine care relationship", () => {
    // This is the C1 gap being closed: facility membership alone is not enough.
    expect(ACTION_POLICIES["document.read.restricted"].minimumRelationship).toBe("DIRECT_CARE");
    expect(ACTION_POLICIES["document.read.restricted"].dataClass).toBe("HIGHLY_SENSITIVE");
  });

  it("requires step-up for the most dangerous actions", () => {
    for (const action of ["exchange.authorize", "privilege.grant", "audit.read.platform"]) {
      expect(ACTION_POLICIES[action].requireStepUp).toBe(true);
    }
  });
});

describe("relationship ranking", () => {
  it("lets a stronger relationship satisfy a weaker requirement", () => {
    expect(relationshipSatisfies("DIRECT_CARE", "FACILITY_STAFF")).toBe(true);
    expect(relationshipSatisfies("FACILITY_STAFF", "FACILITY_STAFF")).toBe(true);
  });

  it("does not let a weaker relationship satisfy a stronger requirement", () => {
    expect(relationshipSatisfies("FACILITY_STAFF", "DIRECT_CARE")).toBe(false);
    expect(relationshipSatisfies("NONE", "FACILITY_STAFF")).toBe(false);
  });

  it("ranks PLATFORM_ADMIN BELOW facility staff for clinical policies", () => {
    // A platform administrator administers the platform. That is not a clinical
    // care relationship and must not silently satisfy one.
    expect(relationshipSatisfies("PLATFORM_ADMIN", "FACILITY_STAFF")).toBe(false);
    expect(relationshipSatisfies("PLATFORM_ADMIN", "DIRECT_CARE")).toBe(false);
  });

  it("keeps PATIENT_SELF on its own axis in both directions", () => {
    // No staff relationship satisfies a self-access policy...
    expect(relationshipSatisfies("DIRECT_CARE", "PATIENT_SELF")).toBe(false);
    expect(relationshipSatisfies("PLATFORM_ADMIN", "PATIENT_SELF")).toBe(false);
    // ...and being the patient does not make you staff.
    expect(relationshipSatisfies("PATIENT_SELF", "FACILITY_STAFF")).toBe(false);
    expect(relationshipSatisfies("PATIENT_SELF", "PATIENT_SELF")).toBe(true);
  });

  it("treats an absent requirement as satisfied", () => {
    expect(relationshipSatisfies("NONE", undefined)).toBe(true);
  });
});

describe("decision shapes", () => {
  it("maps each decision to a sensible status", () => {
    expect(deny("DENY", { policy: "x", reason: "r", deniedAt: "rbac" }).httpStatus).toBe(403);
    expect(deny("REQUIRE_CONSENT", { policy: "x", reason: "r", deniedAt: "consent" }).httpStatus).toBe(403);
    // Step-up is an authentication problem, so 401 — the client must re-auth.
    expect(deny("REQUIRE_STEP_UP_AUTH", { policy: "x", reason: "r", deniedAt: "step-up" }).httpStatus).toBe(401);
    // Cross-facility is 404-shaped so it cannot be used to probe another tenant.
    expect(deny("CONFLICT", { policy: "x", reason: "Not found.", deniedAt: "facility" }).httpStatus).toBe(404);
  });

  it("never marks a denial as via break-glass", () => {
    for (const d of DECISIONS.filter((x) => x !== "ALLOW")) {
      expect(deny(d as never, { policy: "x", reason: "r", deniedAt: "t" }).viaBreakGlass).toBe(false);
    }
  });

  it("produces an allow with a 200 and a recorded relationship", () => {
    const r = allow({
      policy: "patient.read", reason: "ok", relationship: "DIRECT_CARE",
      viaBreakGlass: false, dataClass: "STANDARD_CLINICAL", deniedAt: null,
    });
    expect(r.decision).toBe("ALLOW");
    expect(r.httpStatus).toBe(200);
  });
});

describe("denial error never leaks why", () => {
  const denial = new AuthorizationDeniedError(
    deny("CONFLICT", { policy: "patient.read", reason: "Not found.", deniedAt: "facility-boundary", relationship: "NONE" })
  );

  it("is recognisable and carries its status", () => {
    expect(isAuthorizationDenied(denial)).toBe(true);
    expect(denial.status).toBe(404);
  });

  it("exposes only the message and decision to a client", () => {
    const body = denial.toResponseBody();
    expect(Object.keys(body).sort()).toEqual(["decision", "error"]);
    // No policy internals, no relationship, no facility hint.
    expect(JSON.stringify(body)).not.toContain("facility-boundary");
    expect(JSON.stringify(body)).not.toContain("NONE");
  });

  it("never reveals that a record exists elsewhere", () => {
    expect(denial.message).toBe("Not found.");
    expect(denial.message).not.toMatch(/facility|another|exists/i);
  });
});

describe("break-glass constraints", () => {
  it("demands a meaningful reason", () => {
    expect(MIN_REASON_LENGTH).toBeGreaterThanOrEqual(20);
  });

  it("caps the window and defaults well inside the cap", () => {
    expect(MAX_DURATION_MS).toBeLessThanOrEqual(4 * 60 * 60_000);
    expect(DEFAULT_DURATION_MS).toBeLessThan(MAX_DURATION_MS);
  });

  it("keeps emergency context a closed vocabulary", () => {
    expect(EMERGENCY_CONTEXTS.length).toBeGreaterThan(0);
    expect(EMERGENCY_CONTEXTS).toContain("LIFE_THREATENING");
    expect(EMERGENCY_CONTEXTS).not.toContain("ADMIN_OVERRIDE");
    expect(EMERGENCY_CONTEXTS).not.toContain("CONVENIENCE");
  });
});

describe("privacy workflow", () => {
  it("requires review before approval, and treats rejection as terminal", () => {
    expect(isPrivacyTransitionAllowed("REQUESTED", "UNDER_REVIEW")).toBe(true);
    expect(isPrivacyTransitionAllowed("REQUESTED", "APPROVED")).toBe(false);
    expect(PRIVACY_TRANSITIONS.REJECTED).toEqual([]);
    expect(PRIVACY_TRANSITIONS.ACTIONED).toEqual([]);
  });

  it("only actions an approved request", () => {
    expect(isPrivacyTransitionAllowed("APPROVED", "ACTIONED")).toBe(true);
    expect(isPrivacyTransitionAllowed("REJECTED", "ACTIONED")).toBe(false);
    expect(isPrivacyTransitionAllowed("UNDER_REVIEW", "ACTIONED")).toBe(false);
  });

  it("includes deletion as a REQUEST type", () => {
    expect(PRIVACY_REQUEST_TYPES).toContain("DELETION_REQUEST");
  });

  it("performs NO automated deletion of any record class", () => {
    // The whole point: a deletion request is reviewed, never executed by a job.
    const retention = describeRetention();
    expect(retention.automatedDeletion).toBe(false);
    for (const policy of Object.values(retention.policies)) {
      expect(policy.years).toBeNull();
      expect(policy.note).toMatch(/no automated deletion|never deleted/i);
    }
  });
});

describe("MFA is never reported as verified", () => {
  it("reports NOT_CONFIGURED from every method", async () => {
    const p = getMfaProvider();
    expect(p).toBe(unconfiguredMfaProvider);
    expect((await p.status("u1")).state).toBe("NOT_CONFIGURED");
    expect((await p.challenge("u1")).state).toBe("NOT_CONFIGURED");
    expect((await p.verify("u1", "123456")).state).toBe("NOT_CONFIGURED");
  });

  it("cannot return VERIFIED for any response, including a plausible one", async () => {
    const p = getMfaProvider();
    for (const attempt of ["000000", "123456", "", "true"]) {
      expect((await p.verify("u1", attempt)).state).not.toBe("VERIFIED");
    }
  });
});
