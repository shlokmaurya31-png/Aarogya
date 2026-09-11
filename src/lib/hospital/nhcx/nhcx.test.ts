import { describe, it, expect } from "vitest";
import {
  SUBMISSION_TRANSITIONS, PROTOCOL_TRANSITIONS, QUERY_TRANSITIONS,
  SETTLEMENT_TRANSITIONS, EXCEPTION_TRANSITIONS,
  isTransitionAllowed, isTerminal,
  canonicalStatusForSubmission, canonicalStatusForAdjudication,
} from "./stateMachines";
import {
  NHCX_ERROR_CATEGORIES, NhcxError, isRetryableCategory,
  categoryFromHttpStatus, nextRetryDelayMs,
} from "./errors";
import {
  getNhcxConfig, checkNhcxEnvironmentSafety, describeNhcxConfig, NHCX_ENV_VARS,
} from "./config";
import {
  authenticateCallback, validateCallbackTimestamp, readCallbackOutcome,
  CALLBACK_MAX_SKEW_MS,
} from "./callbacks";
import {
  UnverifiedNhcxAdapter, NhcxContractHarness, getNhcxAdapter, toNhcxError,
} from "./adapter";
import { buildIdempotencyKey } from "./submission";
import { hashPackage } from "./claimPackage";
import {
  NHCX_FHIR_VERSION, NHCX_CLAIM_BUNDLE_TYPE, isTransportContractVerified,
} from "./contract";
import { isClaimTransitionAllowed } from "../billing/claims";

/**
 * Phase C5 — NHCX claims exchange unit tests.
 *
 * These cover the parts that must hold with no database and no network: state
 * machine shape, retry classification, configuration fail-closed behaviour,
 * callback input hardening, idempotency key derivation and the honesty of the
 * adapter boundary. Database-level concurrency and isolation are proven
 * separately in scripts/verify-postgres-nhcx.ts against a real PostgreSQL.
 */

// ─────────────────────────────────────────────────────────────────────────────
describe("C5 state machines — separation from canonical billing", () => {
  it("does not redefine the canonical claim machine", () => {
    // The Phase 5 machine is still the authority on billing state.
    expect(isClaimTransitionAllowed("DRAFT", "SUBMITTED")).toBe(true);
    expect(isClaimTransitionAllowed("DRAFT", "APPROVED")).toBe(false);
  });

  it("keeps protocol states out of the canonical claim vocabulary", () => {
    // ACKNOWLEDGED exists on the exchange, never on Claim.status.
    expect(isClaimTransitionAllowed("SUBMITTED", "ACKNOWLEDGED")).toBe(false);
    expect(PROTOCOL_TRANSITIONS.SUBMITTED).toContain("ACKNOWLEDGED");
  });

  it("allows a submission to progress DRAFT -> READY -> SUBMITTED", () => {
    expect(isTransitionAllowed(SUBMISSION_TRANSITIONS, "DRAFT", "READY")).toBe(true);
    expect(isTransitionAllowed(SUBMISSION_TRANSITIONS, "READY", "SUBMITTED")).toBe(true);
  });

  it("refuses to submit straight from DRAFT, skipping pre-flight", () => {
    expect(isTransitionAllowed(SUBMISSION_TRANSITIONS, "DRAFT", "SUBMITTED")).toBe(false);
  });

  it("lets a FAILED submission retry but never a REJECTED one", () => {
    // A rejection needs a NEW version; resending the same package is what
    // creates a duplicate claim at the payer.
    expect(isTransitionAllowed(SUBMISSION_TRANSITIONS, "FAILED", "SUBMITTED")).toBe(true);
    expect(isTransitionAllowed(SUBMISSION_TRANSITIONS, "REJECTED", "SUBMITTED")).toBe(false);
  });

  it("treats ACCEPTED and SUPERSEDED as terminal submission states", () => {
    expect(isTerminal(SUBMISSION_TRANSITIONS, "ACCEPTED")).toBe(true);
    expect(isTerminal(SUBMISSION_TRANSITIONS, "SUPERSEDED")).toBe(true);
  });

  it("permits an exchange to answer without an intermediate acknowledgement", () => {
    expect(isTransitionAllowed(PROTOCOL_TRANSITIONS, "SUBMITTED", "RESPONDED")).toBe(true);
  });

  it("refuses to resurrect a RESPONDED or CANCELLED exchange", () => {
    expect(isTransitionAllowed(PROTOCOL_TRANSITIONS, "RESPONDED", "SUBMITTED")).toBe(false);
    expect(isTransitionAllowed(PROTOCOL_TRANSITIONS, "CANCELLED", "SUBMITTED")).toBe(false);
  });

  it("allows a FAILED exchange to be retried into SUBMITTED", () => {
    expect(isTransitionAllowed(PROTOCOL_TRANSITIONS, "FAILED", "SUBMITTED")).toBe(true);
  });

  it("walks a query RECEIVED -> UNDER_REVIEW -> RESPONSE_DRAFT -> RESPONSE_SUBMITTED", () => {
    expect(isTransitionAllowed(QUERY_TRANSITIONS, "RECEIVED", "UNDER_REVIEW")).toBe(true);
    expect(isTransitionAllowed(QUERY_TRANSITIONS, "UNDER_REVIEW", "RESPONSE_DRAFT")).toBe(true);
    expect(isTransitionAllowed(QUERY_TRANSITIONS, "RESPONSE_DRAFT", "RESPONSE_SUBMITTED")).toBe(true);
  });

  it("refuses to answer a query that is already RESOLVED or CLOSED", () => {
    expect(isTransitionAllowed(QUERY_TRANSITIONS, "RESOLVED", "RESPONSE_SUBMITTED")).toBe(false);
    expect(isTransitionAllowed(QUERY_TRANSITIONS, "CLOSED", "RESPONSE_SUBMITTED")).toBe(false);
  });

  it("makes a RECONCILED settlement terminal, so reconciliation cannot be undone", () => {
    expect(isTerminal(SETTLEMENT_TRANSITIONS, "RECONCILED")).toBe(true);
    expect(isTransitionAllowed(SETTLEMENT_TRANSITIONS, "RECONCILED", "DISPUTED")).toBe(false);
  });

  it("allows a disputed settlement to be reconciled or rejected", () => {
    expect(isTransitionAllowed(SETTLEMENT_TRANSITIONS, "DISPUTED", "RECONCILED")).toBe(true);
    expect(isTransitionAllowed(SETTLEMENT_TRANSITIONS, "DISPUTED", "REJECTED")).toBe(true);
  });

  it("makes a resolved reconciliation exception terminal", () => {
    expect(isTransitionAllowed(EXCEPTION_TRANSITIONS, "RESOLVED", "OPEN")).toBe(false);
    expect(isTransitionAllowed(EXCEPTION_TRANSITIONS, "OPEN", "RESOLVED")).toBe(true);
  });

  it("rejects transitions from an unknown state rather than defaulting to allow", () => {
    expect(isTransitionAllowed(SUBMISSION_TRANSITIONS, "NOT_A_STATE", "SUBMITTED")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("C5 canonical status mapping", () => {
  it("maps a submitted submission onto the canonical SUBMITTED status", () => {
    expect(canonicalStatusForSubmission("SUBMITTED")).toBe("SUBMITTED");
  });

  it("treats an acknowledgement as UNDER_REVIEW, not as approval", () => {
    expect(canonicalStatusForSubmission("ACKNOWLEDGED")).toBe("UNDER_REVIEW");
  });

  it("refuses to move billing state for ACCEPTED — accepted for adjudication is not approved", () => {
    expect(canonicalStatusForSubmission("ACCEPTED")).toBeNull();
  });

  it("says nothing about billing for DRAFT, READY, FAILED or SUPERSEDED", () => {
    expect(canonicalStatusForSubmission("DRAFT")).toBeNull();
    expect(canonicalStatusForSubmission("READY")).toBeNull();
    expect(canonicalStatusForSubmission("FAILED")).toBeNull();
    expect(canonicalStatusForSubmission("SUPERSEDED")).toBeNull();
  });

  it("maps adjudication outcomes onto canonical claim statuses", () => {
    expect(canonicalStatusForAdjudication("APPROVED")).toBe("APPROVED");
    expect(canonicalStatusForAdjudication("PARTIALLY_APPROVED")).toBe("PARTIALLY_APPROVED");
    expect(canonicalStatusForAdjudication("REJECTED")).toBe("REJECTED");
  });

  it("does not treat PENDING or QUERY as a decision", () => {
    expect(canonicalStatusForAdjudication("PENDING")).toBe("UNDER_REVIEW");
    expect(canonicalStatusForAdjudication("QUERY")).toBe("UNDER_REVIEW");
  });

  it("ignores an unrecognised outcome rather than guessing", () => {
    expect(canonicalStatusForAdjudication("SOMETHING_NEW")).toBeNull();
  });

  it("only ever produces statuses the canonical enum already contains", () => {
    const canonical = [
      "DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED",
      "PARTIALLY_APPROVED", "REJECTED", "SETTLED", "CLOSED",
    ];
    for (const s of ["SUBMITTED", "ACKNOWLEDGED", "REJECTED"] as const) {
      const mapped = canonicalStatusForSubmission(s);
      if (mapped) expect(canonical).toContain(mapped);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("C5 error model — retry safety", () => {
  it("never retries a DUPLICATE: the far side already has the request", () => {
    expect(isRetryableCategory("DUPLICATE")).toBe(false);
  });

  it("never retries validation, authentication, authorization or configuration failures", () => {
    expect(isRetryableCategory("VALIDATION")).toBe(false);
    expect(isRetryableCategory("AUTHENTICATION")).toBe(false);
    expect(isRetryableCategory("AUTHORIZATION")).toBe(false);
    expect(isRetryableCategory("CONFIGURATION")).toBe(false);
  });

  it("retries only genuinely transient categories", () => {
    expect(isRetryableCategory("RATE_LIMIT")).toBe(true);
    expect(isRetryableCategory("NETWORK")).toBe(true);
    expect(isRetryableCategory("TIMEOUT")).toBe(true);
    expect(isRetryableCategory("EXTERNAL_SYSTEM")).toBe(true);
  });

  it("does not retry UNKNOWN — an unclassified failure is not assumed safe", () => {
    expect(isRetryableCategory("UNKNOWN")).toBe(false);
  });

  it("classifies every category explicitly", () => {
    for (const c of NHCX_ERROR_CATEGORIES) {
      expect(typeof isRetryableCategory(c)).toBe("boolean");
    }
  });

  it("maps HTTP statuses onto categories without collapsing 401 and 403", () => {
    expect(categoryFromHttpStatus(400)).toBe("VALIDATION");
    expect(categoryFromHttpStatus(401)).toBe("AUTHENTICATION");
    expect(categoryFromHttpStatus(403)).toBe("AUTHORIZATION");
    expect(categoryFromHttpStatus(409)).toBe("CONFLICT");
    expect(categoryFromHttpStatus(429)).toBe("RATE_LIMIT");
    expect(categoryFromHttpStatus(503)).toBe("EXTERNAL_SYSTEM");
  });

  it("returns no retry delay for a non-retryable category", () => {
    expect(nextRetryDelayMs(0, "VALIDATION")).toBeNull();
    expect(nextRetryDelayMs(0, "DUPLICATE")).toBeNull();
  });

  it("backs off exponentially and caps the delay at 30 minutes", () => {
    expect(nextRetryDelayMs(0, "NETWORK")).toBe(15_000);
    expect(nextRetryDelayMs(1, "NETWORK")).toBe(30_000);
    expect(nextRetryDelayMs(50, "NETWORK")).toBe(30 * 60_000);
  });

  it("backs off harder for rate limiting than for a network blip", () => {
    expect(nextRetryDelayMs(0, "RATE_LIMIT")).toBeGreaterThan(nextRetryDelayMs(0, "NETWORK")!);
  });

  it("keeps external codes and HTTP status out of the public error shape", () => {
    const err = new NhcxError({
      category: "VALIDATION", message: "Bad.", externalCode: "NHCX-9", httpStatus: 400,
    });
    const pub = err.toPublic();
    expect(pub).not.toHaveProperty("externalCode");
    expect(pub).not.toHaveProperty("httpStatus");
    expect(pub.category).toBe("VALIDATION");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("C5 configuration — fails closed", () => {
  it("defaults to DISABLED when nothing is set", () => {
    const c = getNhcxConfig({});
    expect(c.environment).toBe("DISABLED");
    expect(c.configured).toBe(false);
  });

  it("treats an unrecognised environment as DISABLED rather than guessing", () => {
    expect(getNhcxConfig({ [NHCX_ENV_VARS.environment]: "STAGING" }).environment).toBe("DISABLED");
  });

  it("returns no credentials at all while disabled, even if the vars are present", () => {
    const c = getNhcxConfig({
      [NHCX_ENV_VARS.clientSecret]: "leak-me",
      [NHCX_ENV_VARS.baseUrl]: "https://example.invalid",
    });
    expect(c.clientSecret).toBeNull();
    expect(c.baseUrl).toBeNull();
  });

  it("reports exactly which variables are missing in a selected environment", () => {
    const c = getNhcxConfig({ [NHCX_ENV_VARS.environment]: "SANDBOX" });
    expect(c.missing).toContain(NHCX_ENV_VARS.baseUrl);
    expect(c.missing).toContain(NHCX_ENV_VARS.clientId);
    expect(c.configured).toBe(false);
  });

  it("warns when a callback URL is not https", () => {
    const c = getNhcxConfig({
      [NHCX_ENV_VARS.environment]: "SANDBOX",
      [NHCX_ENV_VARS.callbackUrl]: "http://example.invalid/cb",
    });
    expect(c.warnings.some((w) => w.includes(NHCX_ENV_VARS.callbackUrl))).toBe(true);
    expect(c.callbacksConfigured).toBe(false);
  });

  it("does not consider callbacks configured without a token", () => {
    const c = getNhcxConfig({
      [NHCX_ENV_VARS.environment]: "SANDBOX",
      [NHCX_ENV_VARS.callbackUrl]: "https://example.invalid/cb",
    });
    expect(c.callbacksConfigured).toBe(false);
  });

  it("always warns that the transport contract is unverified", () => {
    const c = getNhcxConfig({ [NHCX_ENV_VARS.environment]: "SANDBOX" });
    expect(c.warnings.some((w) => /unverified/i.test(w))).toBe(true);
  });

  it("refuses a non-production deployment pointed at NHCX PRODUCTION", () => {
    const c = getNhcxConfig({
      [NHCX_ENV_VARS.environment]: "PRODUCTION",
      [NHCX_ENV_VARS.baseUrl]: "https://example.invalid",
      [NHCX_ENV_VARS.participantCode]: "X",
      [NHCX_ENV_VARS.clientId]: "X",
      [NHCX_ENV_VARS.clientSecret]: "X",
    });
    expect(checkNhcxEnvironmentSafety(c, "development").safe).toBe(false);
  });

  it("refuses a production deployment pointed at a sandbox", () => {
    const c = getNhcxConfig({
      [NHCX_ENV_VARS.environment]: "SANDBOX",
      [NHCX_ENV_VARS.baseUrl]: "https://example.invalid",
      [NHCX_ENV_VARS.participantCode]: "X",
      [NHCX_ENV_VARS.clientId]: "X",
      [NHCX_ENV_VARS.clientSecret]: "X",
    });
    expect(checkNhcxEnvironmentSafety(c, "production").safe).toBe(false);
  });

  it("treats DISABLED as safe in any NODE_ENV — nothing can be transmitted", () => {
    expect(checkNhcxEnvironmentSafety(getNhcxConfig({}), "production").safe).toBe(true);
  });

  it("never exposes a secret through the redacted description", () => {
    const c = getNhcxConfig({
      [NHCX_ENV_VARS.environment]: "SANDBOX",
      [NHCX_ENV_VARS.clientSecret]: "super-secret-value",
      [NHCX_ENV_VARS.callbackToken]: "callback-secret",
      [NHCX_ENV_VARS.baseUrl]: "https://example.invalid",
      [NHCX_ENV_VARS.participantCode]: "PC",
      [NHCX_ENV_VARS.clientId]: "CID",
    });
    const described = JSON.stringify(describeNhcxConfig(c));
    expect(described).not.toContain("super-secret-value");
    expect(described).not.toContain("callback-secret");
    expect(described).not.toContain("CID");
  });

  it("clamps an absurd request timeout instead of accepting it", () => {
    const c = getNhcxConfig({
      [NHCX_ENV_VARS.environment]: "SANDBOX",
      [NHCX_ENV_VARS.requestTimeoutMs]: "999999999",
    });
    expect(c.requestTimeoutMs).toBeLessThanOrEqual(120_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("C5 callback hardening", () => {
  const base = getNhcxConfig({
    [NHCX_ENV_VARS.environment]: "SANDBOX",
    [NHCX_ENV_VARS.baseUrl]: "https://example.invalid",
    [NHCX_ENV_VARS.participantCode]: "PC",
    [NHCX_ENV_VARS.clientId]: "CID",
    [NHCX_ENV_VARS.clientSecret]: "CS",
    [NHCX_ENV_VARS.callbackUrl]: "https://example.invalid/cb",
    [NHCX_ENV_VARS.callbackToken]: "the-shared-secret",
  });

  it("refuses every callback while NHCX is disabled", () => {
    expect(() => authenticateCallback(getNhcxConfig({}), "anything")).toThrow(NhcxError);
  });

  it("refuses callbacks when no token is configured — unset never means open", () => {
    const c = { ...base, callbackToken: null };
    expect(() => authenticateCallback(c, "anything")).toThrow(/refused/i);
  });

  it("refuses a missing, wrong or wrong-length token", () => {
    expect(() => authenticateCallback(base, null)).toThrow(NhcxError);
    expect(() => authenticateCallback(base, "wrong-secret-x")).toThrow(NhcxError);
    expect(() => authenticateCallback(base, "short")).toThrow(NhcxError);
  });

  it("accepts the configured token", () => {
    expect(() => authenticateCallback(base, "the-shared-secret")).not.toThrow();
  });

  it("requires a timestamp and rejects an unparseable one", () => {
    expect(() => validateCallbackTimestamp(null)).toThrow(/missing a timestamp/i);
    expect(() => validateCallbackTimestamp("not-a-date")).toThrow(/valid instant/i);
  });

  it("rejects a replayed timestamp outside the window, in both directions", () => {
    const now = Date.now();
    const old = new Date(now - CALLBACK_MAX_SKEW_MS - 1_000).toISOString();
    const future = new Date(now + CALLBACK_MAX_SKEW_MS + 1_000).toISOString();
    expect(() => validateCallbackTimestamp(old, now)).toThrow(/window/i);
    expect(() => validateCallbackTimestamp(future, now)).toThrow(/window/i);
  });

  it("accepts a timestamp inside the window", () => {
    const now = Date.now();
    expect(() => validateCallbackTimestamp(new Date(now - 1_000).toISOString(), now)).not.toThrow();
  });

  it("reads nothing out of a non-object body", () => {
    expect(readCallbackOutcome(null).outcome).toBeNull();
    expect(readCallbackOutcome("a string").outcome).toBeNull();
    expect(readCallbackOutcome(42).externalReference).toBeNull();
  });

  it("refuses a float approved amount rather than rounding it", () => {
    expect(readCallbackOutcome({ approvedAmountMinor: 1234.56 }).approvedAmountMinor).toBeNull();
  });

  it("refuses a stringified amount rather than coercing it", () => {
    expect(readCallbackOutcome({ approvedAmountMinor: "50000" }).approvedAmountMinor).toBeNull();
  });

  it("refuses a negative approved amount", () => {
    expect(readCallbackOutcome({ approvedAmountMinor: -1 }).approvedAmountMinor).toBeNull();
  });

  it("accepts a non-negative integer amount", () => {
    expect(readCallbackOutcome({ approvedAmountMinor: 50_000 }).approvedAmountMinor).toBe(50_000);
    expect(readCallbackOutcome({ approvedAmountMinor: 0 }).approvedAmountMinor).toBe(0);
  });

  it("ignores an outcome that is not in the known vocabulary", () => {
    expect(readCallbackOutcome({ outcome: "TOTALLY_APPROVED_TRUST_ME" }).outcome).toBeNull();
  });

  it("normalises a known outcome to upper case", () => {
    expect(readCallbackOutcome({ outcome: "approved" }).outcome).toBe("APPROVED");
  });

  it("truncates oversized external strings instead of storing them whole", () => {
    const long = "x".repeat(5_000);
    const info = readCallbackOutcome({ eventId: long, rejectionReason: long, queryText: long });
    expect(info.externalEventId!.length).toBeLessThanOrEqual(128);
    expect(info.rejectionReason!.length).toBeLessThanOrEqual(500);
    expect(info.queryText!.length).toBeLessThanOrEqual(2_000);
  });

  it("never reads a facility or patient id out of the callback body", () => {
    const info = readCallbackOutcome({ facilityId: "other-facility", patientId: "someone-else" });
    expect(JSON.stringify(info)).not.toContain("other-facility");
    expect(JSON.stringify(info)).not.toContain("someone-else");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("C5 idempotency and package hashing", () => {
  const parts = { facilityId: "f1", claimId: "c1", version: 1, packageHash: "abc" };

  it("is deterministic for identical inputs", () => {
    expect(buildIdempotencyKey(parts)).toBe(buildIdempotencyKey({ ...parts }));
  });

  it("namespaces by facility, so two facilities cannot collide", () => {
    expect(buildIdempotencyKey(parts)).not.toBe(buildIdempotencyKey({ ...parts, facilityId: "f2" }));
  });

  it("changes when the submission version changes", () => {
    expect(buildIdempotencyKey(parts)).not.toBe(buildIdempotencyKey({ ...parts, version: 2 }));
  });

  it("changes when the package contents change", () => {
    expect(buildIdempotencyKey(parts)).not.toBe(buildIdempotencyKey({ ...parts, packageHash: "def" }));
  });

  it("hashes a package independently of key order", () => {
    const a = hashPackage({ claimId: "c1", amount: 100, nested: { b: 2, a: 1 } });
    const b = hashPackage({ nested: { a: 1, b: 2 }, amount: 100, claimId: "c1" });
    expect(a.hash).toBe(b.hash);
  });

  it("produces a different hash when an amount changes by one minor unit", () => {
    expect(hashPackage({ amount: 100 }).hash).not.toBe(hashPackage({ amount: 101 }).hash);
  });

  it("reports the canonical byte size alongside the hash", () => {
    const { hash, bytes } = hashPackage({ a: 1 });
    expect(hash).toHaveLength(64);
    expect(bytes).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("C5 adapter boundary — no fabricated connectivity", () => {
  it("ships an adapter that reports the transport contract as unverified", () => {
    expect(isTransportContractVerified()).toBe(false);
  });

  it("returns the unverified adapter from the factory, never the test harness", async () => {
    const adapter = getNhcxAdapter();
    expect(adapter).toBeInstanceOf(UnverifiedNhcxAdapter);
    expect(adapter.name).toBe("NHCX");
  });

  it("advertises zero operations, so no dashboard can render capability", async () => {
    const caps = await new UnverifiedNhcxAdapter().capabilities();
    expect(caps.operations).toEqual([]);
    expect(caps.transportContractVerified).toBe(false);
    expect(caps.blockers.length).toBeGreaterThan(0);
  });

  it("never returns OK from submit", async () => {
    const res = await new UnverifiedNhcxAdapter().submit({
      facilityId: "f1", correlationId: "corr", idempotencyKey: "key",
      exchangeType: "CLAIM", bundle: {},
    });
    expect(res.outcome).not.toBe("OK");
    expect(["NOT_CONFIGURED", "NOT_IMPLEMENTED"]).toContain(res.outcome);
    expect(res.retryable).toBe(false);
  });

  it("never returns OK from checkStatus", async () => {
    const res = await new UnverifiedNhcxAdapter().checkStatus("corr");
    expect(res.outcome).not.toBe("OK");
  });

  it("labels the test harness unmistakably so it cannot pass for a connection", async () => {
    const harness = new NhcxContractHarness("SUCCESS");
    expect(harness.name).toContain("HARNESS");
    const caps = await harness.capabilities();
    expect(caps.environment).toBe("TEST_HARNESS");
    expect(caps.blockers.join(" ")).toMatch(/NOT an NHCX connection/i);
  });

  it("marks a harness reference so it is recognisable if it ever surfaces", async () => {
    const res = await new NhcxContractHarness("SUCCESS").submit({
      facilityId: "f1", correlationId: "c", idempotencyKey: "abcdef123456", exchangeType: "CLAIM", bundle: {},
    });
    expect(res.externalReference).toMatch(/^HARNESS-/);
    expect(res.message).toMatch(/NOT a real NHCX submission/i);
  });

  it("plays a scripted failure sequence for retry testing", async () => {
    const harness = new NhcxContractHarness(["SERVER_ERROR", "SUCCESS"]);
    const payload = {
      facilityId: "f1", correlationId: "c", idempotencyKey: "k", exchangeType: "CLAIM", bundle: {},
    };
    const first = await harness.submit(payload);
    const second = await harness.submit(payload);
    expect(first.outcome).toBe("TRANSIENT_ERROR");
    expect(first.retryable).toBe(true);
    expect(second.outcome).toBe("OK");
    expect(harness.callCount).toBe(2);
  });

  it("never marks a harness DUPLICATE as retryable", async () => {
    const res = await new NhcxContractHarness("DUPLICATE").submit({
      facilityId: "f1", correlationId: "c", idempotencyKey: "k", exchangeType: "CLAIM", bundle: {},
    });
    expect(res.retryable).toBe(false);
  });

  it("classifies NOT_IMPLEMENTED as a protocol failure, not a transient one", () => {
    const err = toNhcxError(
      { outcome: "NOT_IMPLEMENTED", message: "no contract", retryable: false }, "corr"
    );
    expect(err.category).toBe("PROTOCOL");
    expect(err.retryable).toBe(false);
  });

  it("classifies NOT_CONFIGURED as a configuration failure", () => {
    const err = toNhcxError(
      { outcome: "NOT_CONFIGURED", message: "unset", retryable: false }, "corr"
    );
    expect(err.category).toBe("CONFIGURATION");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("C5 verified FHIR contract constants", () => {
  it("pins FHIR R4 4.0.1, as stated in the NRCeS implementation guide", () => {
    expect(NHCX_FHIR_VERSION).toBe("4.0.1");
  });

  it("uses a collection bundle for claims, not the ABDM document bundle", () => {
    // A document bundle requires a Composition as its first entry; the claim
    // bundle is a collection. Conflating them would produce an invalid payload.
    expect(NHCX_CLAIM_BUNDLE_TYPE).toBe("collection");
    expect(NHCX_CLAIM_BUNDLE_TYPE).not.toBe("document");
  });
});
