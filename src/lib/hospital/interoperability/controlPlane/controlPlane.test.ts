import { describe, it, expect } from "vitest";
import {
  evaluateReadiness, canDispatch, READINESS_STATES, type ReadinessEvidence,
} from "./readiness";
import {
  describeSystem, listSystems, assertKnownSystem,
  INTEGRATION_SYSTEMS, INTEGRATION_CAPABILITIES,
} from "./registry";
import { validateConfiguration, assertNoSecrets, CONTROL_PLANE_ENVIRONMENTS } from "./configuration";
import { deriveCertificateStatus, EXPIRY_WARNING_MS } from "./certificates";
import { isTrustTransitionAllowed, isParticipantUsable, TRUST_STATUSES } from "./participants";
import {
  normaliseFailureCategory, isAutoRetryable, FAILURE_CATEGORIES, OPERATIONAL_STATES,
} from "./exchanges";
import { assessRetryEligibility } from "./operations";
import { getActionPolicy } from "@/lib/auth/authorize/policies";
import { PERMISSIONS, roleHasPermission } from "@/lib/auth/permissions";

/**
 * Phase C6 — interoperability control plane unit tests.
 *
 * These cover what must hold with no database and no network: readiness never
 * outrunning its evidence, the secret boundary, certificate lifecycle
 * arithmetic, participant trust transitions, failure classification and retry
 * safety. Concurrency, tenant isolation and end-to-end authorization are proven
 * separately in scripts/verify-postgres-interoperability-control-plane.ts
 * against real PostgreSQL.
 */

const base: ReadinessEvidence = {
  architectureComplete: true,
  contractVerified: true,
  contractBlockedReason: null,
  configurationValid: true,
  configurationMissing: [],
  testsPresent: true,
  environment: "SANDBOX",
  enabled: true,
  sandboxVerifiedAt: null,
  productionVerifiedAt: null,
  productionApprovedAt: null,
  liveOperations: ["send"],
};

// ─────────────────────────────────────────────────────────────────────────────
describe("C6 readiness — a label can never outrun its evidence", () => {
  it("reports DISABLED when the operator switched it off, however well configured", () => {
    const r = evaluateReadiness({ ...base, enabled: false, sandboxVerifiedAt: new Date() });
    expect(r.state).toBe("DISABLED");
  });

  it("reports DISABLED when no environment is selected", () => {
    expect(evaluateReadiness({ ...base, environment: "DISABLED" }).state).toBe("DISABLED");
  });

  it("reports BLOCKED when the contract is unverified, even if everything else passes", () => {
    const r = evaluateReadiness({ ...base, contractVerified: false, contractBlockedReason: "Spec host returned 403." });
    expect(r.state).toBe("BLOCKED");
    expect(r.summary).toContain("403");
  });

  it("reports NOT_CONFIGURED when required configuration is missing", () => {
    const r = evaluateReadiness({ ...base, configurationValid: false, configurationMissing: ["baseUrl"] });
    expect(r.state).toBe("NOT_CONFIGURED");
    expect(r.blockers.join(" ")).toContain("baseUrl");
  });

  it("reports TEST_VERIFIED when tests pass but no sandbox call has ever succeeded", () => {
    expect(evaluateReadiness(base).state).toBe("TEST_VERIFIED");
  });

  it("reports SANDBOX_VERIFIED only when a real sandbox call succeeded", () => {
    expect(evaluateReadiness({ ...base, sandboxVerifiedAt: new Date() }).state).toBe("SANDBOX_VERIFIED");
  });

  it("never reports a production state for a PRODUCTION environment that was not approved", () => {
    const r = evaluateReadiness({ ...base, environment: "PRODUCTION" });
    expect(r.state).toBe("CONFIGURED");
    expect(r.state).not.toBe("PRODUCTION_ENABLED");
    expect(r.blockers.join(" ")).toMatch(/approved/i);
  });

  it("reports PRODUCTION_ENABLED once approved but before any production call succeeds", () => {
    const r = evaluateReadiness({ ...base, environment: "PRODUCTION", productionApprovedAt: new Date() });
    expect(r.state).toBe("PRODUCTION_ENABLED");
  });

  it("reports PRODUCTION_VERIFIED only with a real production timestamp", () => {
    const r = evaluateReadiness({
      ...base, environment: "PRODUCTION",
      productionApprovedAt: new Date(), productionVerifiedAt: new Date(),
    });
    expect(r.state).toBe("PRODUCTION_VERIFIED");
  });

  it("cannot reach PRODUCTION_VERIFIED from sandbox evidence alone", () => {
    const r = evaluateReadiness({ ...base, sandboxVerifiedAt: new Date(), productionApprovedAt: new Date() });
    expect(r.state).not.toBe("PRODUCTION_VERIFIED");
    expect(r.state).not.toBe("PRODUCTION_ENABLED");
  });

  it("keeps all six dimensions independently visible", () => {
    const r = evaluateReadiness({ ...base, contractVerified: false, testsPresent: false });
    expect(Object.keys(r.dimensions).sort()).toEqual(
      ["architecture", "configuration", "contract", "production", "sandbox", "tests"]
    );
    expect(r.dimensions.contract).toBe("BLOCKED");
    expect(r.dimensions.tests).toBe("FAIL");
  });

  it("returns only states from the declared vocabulary", () => {
    const variants: ReadinessEvidence[] = [
      base,
      { ...base, enabled: false },
      { ...base, contractVerified: false },
      { ...base, configurationValid: false },
      { ...base, architectureComplete: false },
      { ...base, environment: "PRODUCTION", productionApprovedAt: new Date() },
    ];
    for (const v of variants) {
      expect(READINESS_STATES).toContain(evaluateReadiness(v).state);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("C6 dispatch gate", () => {
  it("allows dispatch only when every precondition holds", () => {
    expect(canDispatch(base).allowed).toBe(true);
  });

  it("refuses a disabled integration", () => {
    expect(canDispatch({ ...base, enabled: false }).allowed).toBe(false);
  });

  it("refuses an unverified contract however enabled it is", () => {
    const d = canDispatch({ ...base, contractVerified: false });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/contract/i);
  });

  it("refuses production that has not been approved", () => {
    const d = canDispatch({ ...base, environment: "PRODUCTION" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/approved/i);
  });

  it("believes the adapter when it advertises no operations", () => {
    const d = canDispatch({ ...base, liveOperations: [] });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/no operations/i);
  });

  it("refuses incomplete configuration and names what is missing", () => {
    const d = canDispatch({ ...base, configurationValid: false, configurationMissing: ["ABDM_CLIENT_ID"] });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("ABDM_CLIENT_ID");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("C6 registry — only integrations that genuinely exist", () => {
  it("registers exactly the three systems that have adapters", () => {
    expect([...INTEGRATION_SYSTEMS]).toEqual(["ABDM", "FHIR", "NHCX"]);
  });

  it("rejects an integration nobody implemented", () => {
    expect(() => assertKnownSystem("PAYER_API")).toThrow();
    expect(() => assertKnownSystem("EXTERNAL_EMR")).toThrow();
  });

  it("reports ABDM's contract as verified against a named published source", () => {
    const d = describeSystem("ABDM");
    expect(d.contractVerified).toBe(true);
    expect(d.contractSource?.url).toContain("abdm.gov.in");
  });

  it("reports NHCX's transport contract as UNVERIFIED with the reason preserved", () => {
    const d = describeSystem("NHCX");
    expect(d.contractVerified).toBe(false);
    expect(d.contractBlockedReason).toBeTruthy();
    expect(d.transportImplemented).toBe(false);
  });

  it("never advertises NHCX claim submission as implemented transport", () => {
    const claim = describeSystem("NHCX").capabilities.find((c) => c.capability === "CLAIM_SUBMISSION");
    expect(claim?.support).toBe("DOMAIN_ONLY");
    expect(claim?.support).not.toBe("IMPLEMENTED");
  });

  it("marks ABDM health-information RESPONSE as domain-only, since ECDH is not implemented", () => {
    const cap = describeSystem("ABDM").capabilities.find((c) => c.capability === "HEALTH_INFORMATION_RESPONSE");
    expect(cap?.support).toBe("DOMAIN_ONLY");
  });

  it("describes FHIR as having no transport of its own", () => {
    expect(describeSystem("FHIR").transportImplemented).toBe(false);
  });

  it("uses only capabilities from the declared vocabulary", () => {
    for (const s of listSystems()) {
      for (const c of s.capabilities) {
        expect(INTEGRATION_CAPABILITIES).toContain(c.capability);
      }
    }
  });

  it("gives every declared capability an explicit support value", () => {
    for (const s of listSystems()) {
      expect(s.capabilities).toHaveLength(INTEGRATION_CAPABILITIES.length);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("C6 secret boundary", () => {
  it("refuses a body carrying a client secret", () => {
    expect(() => assertNoSecrets({ system: "ABDM", clientSecret: "abc" })).toThrow(/never stored/i);
  });

  it("refuses every known credential key name", () => {
    for (const k of ["client_secret", "token", "accessToken", "apiKey", "password", "privateKey", "certificate"]) {
      expect(() => assertNoSecrets({ [k]: "x" })).toThrow();
    }
  });

  it("refuses PEM material even under an innocuous key name", () => {
    expect(() =>
      assertNoSecrets({ note: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----" })
    ).toThrow(/never be submitted/i);
  });

  it("refuses a certificate body under an innocuous key name", () => {
    expect(() =>
      assertNoSecrets({ description: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----" })
    ).toThrow();
  });

  it("accepts an ordinary configuration body", () => {
    expect(() =>
      assertNoSecrets({ system: "ABDM", environment: "SANDBOX", baseUrl: "https://dev.abdm.gov.in", clientIdEnvVar: "ABDM_CLIENT_ID" })
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("C6 configuration validation", () => {
  const ok = { system: "ABDM" as const, environment: "SANDBOX", baseUrl: "https://dev.abdm.gov.in", clientIdEnvVar: "ABDM_CLIENT_ID" };

  it("accepts a complete sandbox configuration", () => {
    expect(validateConfiguration(ok).valid).toBe(true);
  });

  it("requires a base URL outside FHIR", () => {
    expect(validateConfiguration({ ...ok, baseUrl: null }).missing).toContain("baseUrl");
  });

  it("does not require a base URL for FHIR, which composes in-process", () => {
    const v = validateConfiguration({ system: "FHIR", environment: "LOCAL", baseUrl: null, clientIdEnvVar: null });
    expect(v.valid).toBe(true);
  });

  it("refuses plaintext http outside LOCAL", () => {
    const v = validateConfiguration({ ...ok, baseUrl: "http://dev.abdm.gov.in" });
    expect(v.valid).toBe(false);
    expect(v.invalid.join(" ")).toMatch(/https/i);
  });

  it("refuses a clientIdEnvVar that looks like a value rather than a variable name", () => {
    const v = validateConfiguration({ ...ok, clientIdEnvVar: "SBX_001234" });
    // Underscore-and-digits after an initial capital is a legal env-var name, so
    // the real protection is the shape rule plus the secret-key rejection.
    expect(v.valid).toBe(true);
    const bad = validateConfiguration({ ...ok, clientIdEnvVar: "my-client-id-value" });
    expect(bad.valid).toBe(false);
    expect(bad.invalid.join(" ")).toMatch(/NAME/);
  });

  it("refuses an unknown environment", () => {
    const v = validateConfiguration({ ...ok, environment: "STAGING" });
    expect(v.valid).toBe(false);
  });

  it("warns that production still needs approval", () => {
    const v = validateConfiguration({ ...ok, environment: "PRODUCTION" });
    expect(v.warnings.join(" ")).toMatch(/approv/i);
  });

  it("treats DISABLED as valid with nothing configured", () => {
    expect(validateConfiguration({ system: "ABDM", environment: "DISABLED" }).valid).toBe(true);
  });

  it("declares exactly four environments, LOCAL among them", () => {
    expect([...CONTROL_PLANE_ENVIRONMENTS]).toEqual(["DISABLED", "LOCAL", "SANDBOX", "PRODUCTION"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("C6 certificate lifecycle", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const at = (ms: number) => new Date(now.getTime() + ms);

  it("reports NOT_CONFIGURED with no material reference", () => {
    expect(deriveCertificateStatus({ notBefore: null, notAfter: null, materialRef: null }, now)).toBe("NOT_CONFIGURED");
  });

  it("refuses to call a never-inspected certificate VALID", () => {
    const s = deriveCertificateStatus({ notBefore: null, notAfter: null, materialRef: "env:ABDM_CERT" }, now);
    expect(s).toBe("INVALID");
    expect(s).not.toBe("VALID");
  });

  it("reports VALID well before expiry", () => {
    expect(deriveCertificateStatus(
      { notBefore: at(-1000), notAfter: at(EXPIRY_WARNING_MS * 3), materialRef: "ref" }, now
    )).toBe("VALID");
  });

  it("reports EXPIRING inside the warning window", () => {
    expect(deriveCertificateStatus(
      { notBefore: at(-1000), notAfter: at(EXPIRY_WARNING_MS - 1000), materialRef: "ref" }, now
    )).toBe("EXPIRING");
  });

  it("reports EXPIRED once past notAfter", () => {
    expect(deriveCertificateStatus(
      { notBefore: at(-10_000), notAfter: at(-1), materialRef: "ref" }, now
    )).toBe("EXPIRED");
  });

  it("reports INVALID before notBefore", () => {
    expect(deriveCertificateStatus(
      { notBefore: at(10_000), notAfter: at(100_000), materialRef: "ref" }, now
    )).toBe("INVALID");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("C6 participant trust — identity is not trust", () => {
  it("starts every participant UNVERIFIED", () => {
    expect(TRUST_STATUSES[0]).toBe("UNVERIFIED");
  });

  it("only treats an ACTIVE and VERIFIED participant as usable", () => {
    expect(isParticipantUsable({ status: "ACTIVE", trustStatus: "VERIFIED" })).toBe(true);
    expect(isParticipantUsable({ status: "ACTIVE", trustStatus: "UNVERIFIED" })).toBe(false);
    expect(isParticipantUsable({ status: "ACTIVE", trustStatus: "SUSPENDED" })).toBe(false);
    expect(isParticipantUsable({ status: "INACTIVE", trustStatus: "VERIFIED" })).toBe(false);
  });

  it("allows verification and suspension from UNVERIFIED", () => {
    expect(isTrustTransitionAllowed("UNVERIFIED", "VERIFIED")).toBe(true);
    expect(isTrustTransitionAllowed("UNVERIFIED", "SUSPENDED")).toBe(true);
  });

  it("allows a suspended participant to be reinstated", () => {
    expect(isTrustTransitionAllowed("SUSPENDED", "VERIFIED")).toBe(true);
  });

  it("makes REVOKED terminal, so re-trusting needs a deliberate new record", () => {
    expect(isTrustTransitionAllowed("REVOKED", "VERIFIED")).toBe(false);
    expect(isTrustTransitionAllowed("REVOKED", "UNVERIFIED")).toBe(false);
  });

  it("rejects a transition from an unknown status rather than defaulting to allow", () => {
    expect(isTrustTransitionAllowed("NOT_A_STATUS", "VERIFIED")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("C6 failure classification and retry safety", () => {
  it("never auto-retries a consent or authorization refusal", () => {
    expect(isAutoRetryable("CONSENT")).toBe(false);
    expect(isAutoRetryable("AUTHORIZATION")).toBe(false);
    expect(isAutoRetryable("AUTHENTICATION")).toBe(false);
  });

  it("never auto-retries a duplicate", () => {
    expect(isAutoRetryable("DUPLICATE")).toBe(false);
  });

  it("never auto-retries an unclassified failure", () => {
    expect(isAutoRetryable("UNKNOWN")).toBe(false);
  });

  it("retries only genuinely transient categories", () => {
    expect(isAutoRetryable("NETWORK")).toBe(true);
    expect(isAutoRetryable("TIMEOUT")).toBe(true);
    expect(isAutoRetryable("RATE_LIMIT")).toBe(true);
    expect(isAutoRetryable("EXTERNAL_SYSTEM")).toBe(true);
  });

  it("classifies every declared category explicitly", () => {
    for (const c of FAILURE_CATEGORIES) {
      expect(typeof isAutoRetryable(c)).toBe("boolean");
    }
  });

  it("maps an unrecognised label to UNKNOWN rather than guessing", () => {
    expect(normaliseFailureCategory("something-new")).toBe("UNKNOWN");
    expect(normaliseFailureCategory(null)).toBe("UNKNOWN");
  });

  it("normalises C2/C3 ABDM labels onto the shared vocabulary", () => {
    expect(normaliseFailureCategory("AUTH_FAILURE")).toBe("AUTHENTICATION");
    expect(normaliseFailureCategory("MALFORMED_BODY")).toBe("VALIDATION");
    expect(normaliseFailureCategory("NETWORK_ERROR")).toBe("NETWORK");
    expect(normaliseFailureCategory("NOT_IMPLEMENTED")).toBe("PROTOCOL");
  });

  it("does not collapse authentication into authorization", () => {
    expect(normaliseFailureCategory("AUTHENTICATION")).not.toBe(normaliseFailureCategory("AUTHORIZATION"));
  });

  it("declares REQUIRES_REVIEW as an operational state in its own right", () => {
    expect(OPERATIONAL_STATES).toContain("REQUIRES_REVIEW");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("C6 manual retry eligibility", () => {
  it("refuses to retry anything that is not failed", () => {
    const r = assessRetryEligibility({ state: "COMPLETED", category: "NETWORK", attemptCount: 0, maxAttempts: 3 });
    expect(r.eligible).toBe(false);
  });

  it("refuses once the attempt budget is spent", () => {
    const r = assessRetryEligibility({ state: "FAILED", category: "NETWORK", attemptCount: 3, maxAttempts: 3 });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/exhausted/i);
  });

  it("refuses a consent failure however many attempts remain — a human cannot click past consent", () => {
    const r = assessRetryEligibility({ state: "FAILED", category: "CONSENT", attemptCount: 0, maxAttempts: 3 });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/not retryable/i);
  });

  it("refuses an authorization failure", () => {
    expect(assessRetryEligibility({ state: "FAILED", category: "AUTHORIZATION", attemptCount: 0, maxAttempts: 3 }).eligible)
      .toBe(false);
  });

  it("allows a transient failure with budget remaining", () => {
    expect(assessRetryEligibility({ state: "FAILED", category: "TIMEOUT", attemptCount: 1, maxAttempts: 3 }).eligible)
      .toBe(true);
  });

  it("allows retry from REQUIRES_REVIEW only when budget genuinely remains", () => {
    expect(assessRetryEligibility({ state: "REQUIRES_REVIEW", category: "NETWORK", attemptCount: 3, maxAttempts: 3 }).eligible)
      .toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("C6 authorization policies", () => {
  const ACTIONS = [
    "integration.read", "integration.configure", "integration.enable", "integration.disable",
    "integration.approveProduction", "integration.participant.manage",
    "integration.participant.verify", "integration.exchange.retry",
  ];

  it("defines a policy for every control-plane action", () => {
    for (const a of ACTIONS) expect(getActionPolicy(a)).toBeTruthy();
  });

  it("forbids break-glass on every control-plane action", () => {
    for (const a of ACTIONS) {
      expect(getActionPolicy(a)?.breakGlassAllowed).toBe(false);
    }
  });

  it("requires step-up for configuration, enablement, approval, verification and retry", () => {
    for (const a of [
      "integration.configure", "integration.enable", "integration.approveProduction",
      "integration.participant.verify", "integration.exchange.retry",
    ]) {
      expect(getActionPolicy(a)?.requireStepUp).toBe(true);
    }
  });

  it("deliberately does NOT require step-up to disable — the fail-safe direction stays unobstructed", () => {
    expect(getActionPolicy("integration.disable")?.requireStepUp).toBeFalsy();
  });

  it("uses a different permission for approval than for configuration, so maker cannot be checker", () => {
    expect(getActionPolicy("integration.approveProduction")?.permission)
      .not.toBe(getActionPolicy("integration.configure")?.permission);
  });

  it("classifies control-plane resources as OPERATIONAL, never clinical", () => {
    for (const a of ACTIONS) expect(getActionPolicy(a)?.dataClass).toBe("OPERATIONAL");
  });

  it("requires no patient consent for any control-plane action", () => {
    for (const a of ACTIONS) expect(getActionPolicy(a)?.requireConsent).toBeFalsy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("C6 permission grants — maker and checker are different people", () => {
  it("registers the new control-plane permissions", () => {
    for (const p of [
      "interop:integration:approve", "interop:participant:manage",
      "interop:participant:verify", "interop:exchange:retry",
    ]) {
      expect(PERMISSIONS).toContain(p);
    }
  });

  it("lets a facility admin configure but NOT approve its own production move", () => {
    expect(roleHasPermission("HOSPITAL_ADMIN", "interop:connection:manage")).toBe(true);
    expect(roleHasPermission("HOSPITAL_ADMIN", "interop:integration:approve")).toBe(false);
  });

  it("gives the platform admin the checker permission and nothing operational with it", () => {
    expect(roleHasPermission("AAROGYA_ADMIN", "interop:integration:approve")).toBe(true);
    expect(roleHasPermission("AAROGYA_ADMIN", "interop:connection:manage")).toBe(false);
    expect(roleHasPermission("AAROGYA_ADMIN", "interop:exchange:retry")).toBe(false);
  });

  it("does not give a clinician any integration administration", () => {
    for (const p of [
      "interop:connection:manage", "interop:integration:approve",
      "interop:participant:verify", "interop:exchange:retry",
    ] as const) {
      expect(roleHasPermission("DOCTOR", p)).toBe(false);
      expect(roleHasPermission("NURSE", p)).toBe(false);
    }
  });
});
