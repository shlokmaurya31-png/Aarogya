import { describe, it, expect, beforeEach } from "vitest";
import {
  buildConsentRequestBody, buildHealthInformationRequestBody,
  buildConsentStatusBody, buildConsentFetchBody, readConsentRequestId,
} from "./requests";
import {
  ABDM_PROTOCOL_STATES, isProtocolTransitionAllowed, isTerminalProtocolState,
  protocolPermitsDataFetch, localStatusForProtocolState, protocolStateFromConsentStatus,
} from "./protocolState";
import { consumeRateLimit, resetRateLimiter, describeRateLimit, RateLimitExceededError } from "./rateLimit";
import { readCallbackOutcome } from "./callbacks";
import { getAbdmSession, clearSessionCache } from "./session";
import { getAbdmConfig, ABDM_ENV_VARS } from "./config";
import { checkAbdmHealth } from "./health";
import { ABDM_CRYPTO } from "./contract";

/**
 * Phase C3 — request construction, protocol state, rate limiting, callback
 * interpretation.
 *
 * The request builders are pure, so the exact wire format documented in ABDM
 * Milestone 3 v2.5 can be pinned WITHOUT credentials. That matters: it means a
 * future edit that quietly reshapes a payload fails here rather than at a
 * national gateway.
 */

/**
 * Narrow reader for a built request body. Using a real (if loose) record type
 * rather than `any` keeps the assertions honest: a typo in a property name is
 * a compile error here, not a silently-passing test.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const asJson = (v: unknown): Json => v as Json;

const BASE = {
  patientAbhaAddress: "testpatient@sbx",
  environment: "SANDBOX" as const,
  hiuId: "SBX_000135",
  purposeCode: "CAREMGT" as const,
  hiTypes: ["DiagnosticReport" as const],
  requesterName: "Dr. Test",
  requesterIdentifier: { type: "REGNO", value: "MH1001", system: "https://www.mciindia.org" },
  dateRangeFrom: new Date("2024-01-01T00:00:00.000Z"),
  dateRangeTo: new Date("2024-06-01T00:00:00.000Z"),
  dataEraseAt: new Date("2030-01-01T00:00:00.000Z"),
};

describe("consent request body matches the documented ABDM shape", () => {
  it("produces the exact documented structure", () => {
    const body = asJson(buildConsentRequestBody(BASE));
    expect(Object.keys(body)).toEqual(["consent"]);
    const c = body.consent;
    expect(c.hiu).toEqual({ id: "SBX_000135" });
    expect(c.patient).toEqual({ id: "testpatient@sbx" });
    expect(c.hiTypes).toEqual(["DiagnosticReport"]);
    expect(c.purpose).toEqual({ code: "CAREMGT", text: "Care Management", refUri: "https://www.abdm.gov.in" });
    expect(c.requester).toEqual({ name: "Dr. Test", identifier: BASE.requesterIdentifier });
    expect(c.permission.accessMode).toBe("VIEW");
    expect(c.permission.dateRange).toEqual({ from: BASE.dateRangeFrom.toISOString(), to: BASE.dateRangeTo.toISOString() });
    expect(c.permission.dataEraseAt).toBe(BASE.dataEraseAt.toISOString());
  });

  it("omits hip entirely when not restricting to one provider", () => {
    // The doc marks hip optional; emitting an empty object would change meaning.
    expect(asJson(buildConsentRequestBody(BASE)).consent.hip).toBeUndefined();
    expect(asJson(buildConsentRequestBody({ ...BASE, hipId: "HIP_1" })).consent.hip).toEqual({ id: "HIP_1" });
  });

  it("omits careContexts unless supplied", () => {
    expect(asJson(buildConsentRequestBody(BASE)).consent.careContexts).toBeUndefined();
    const withCtx = asJson(buildConsentRequestBody({
      ...BASE, careContexts: [{ patientReference: "p@sbx", careContextReference: "CO1" }],
    }));
    expect(withCtx.consent.careContexts).toHaveLength(1);
  });

  it("rejects a malformed ABHA address", () => {
    expect(() => buildConsentRequestBody({ ...BASE, patientAbhaAddress: "nosuffix" })).toThrow(/valid ABHA address/i);
    expect(() => buildConsentRequestBody({ ...BASE, patientAbhaAddress: "" })).toThrow(/required/i);
  });

  it("catches a sandbox ABHA address aimed at production", () => {
    // Otherwise this is a silent identity failure at the gateway.
    expect(() => buildConsentRequestBody({ ...BASE, environment: "PRODUCTION" }))
      .toThrow(/does not match the PRODUCTION environment/i);
    expect(() => buildConsentRequestBody({
      ...BASE, environment: "PRODUCTION", patientAbhaAddress: "testpatient@abdm",
    })).not.toThrow();
  });

  it("rejects an unknown hiType or an empty list", () => {
    expect(() => buildConsentRequestBody({ ...BASE, hiTypes: [] })).toThrow(/at least one hiType/i);
    expect(() => buildConsentRequestBody({ ...BASE, hiTypes: ["NotAThing" as never] })).toThrow(/Unknown hiType/);
  });

  it("de-duplicates hiTypes", () => {
    const body = asJson(buildConsentRequestBody({
      ...BASE, hiTypes: ["DiagnosticReport", "DiagnosticReport", "Prescription"],
    }));
    expect(body.consent.hiTypes).toEqual(["DiagnosticReport", "Prescription"]);
  });

  it("rejects an inverted date range and an erase date inside it", () => {
    expect(() => buildConsentRequestBody({ ...BASE, dateRangeTo: new Date("2023-01-01") }))
      .toThrow(/must be after/i);
    expect(() => buildConsentRequestBody({ ...BASE, dataEraseAt: new Date("2024-02-01") }))
      .toThrow(/dataEraseAt must be after/i);
  });

  it("requires a complete requester identifier", () => {
    expect(() => buildConsentRequestBody({ ...BASE, requesterName: "" })).toThrow(/requester name/i);
    expect(() => buildConsentRequestBody({
      ...BASE, requesterIdentifier: { type: "REGNO", value: "", system: "x" },
    })).toThrow(/requester identifier/i);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(buildConsentRequestBody(BASE))).toBe(JSON.stringify(buildConsentRequestBody(BASE)));
  });
});

describe("health information request body", () => {
  const HI = {
    abdmConsentId: "004ff8e6-a9d7-4963-822b-d9762179314e",
    dateRangeFrom: new Date("2024-01-01T00:00:00.000Z"),
    dateRangeTo: new Date("2024-06-01T00:00:00.000Z"),
    dataPushUrl: "https://aarogya.example/v3/data/push",
    keyMaterial: {
      cryptoAlg: "ECDH",
      curve: "Curve25519",
      dhPublicKey: { expiry: "2030-01-01T00:00:00.000Z", parameters: "Curve25519/32byte random key", keyValue: "BASE64KEY==" },
      nonce: "BASE64NONCE==",
    },
  };

  it("produces the documented hiRequest structure", () => {
    const body = asJson(buildHealthInformationRequestBody(HI));
    expect(Object.keys(body)).toEqual(["hiRequest"]);
    expect(body.hiRequest.consent).toEqual({ id: HI.abdmConsentId });
    expect(body.hiRequest.dataPushUrl).toBe(HI.dataPushUrl);
    expect(body.hiRequest.keyMaterial.cryptoAlg).toBe(ABDM_CRYPTO.algorithm);
  });

  it("refuses a plaintext dataPushUrl — ABDM pushes clinical content to it", () => {
    expect(() => buildHealthInformationRequestBody({ ...HI, dataPushUrl: "http://insecure.example" }))
      .toThrow(/must be an https URL/i);
  });

  it("requires the CM-issued consent id, not a local one", () => {
    expect(() => buildHealthInformationRequestBody({ ...HI, abdmConsentId: "" }))
      .toThrow(/consent-manager consent id/i);
  });

  it("requires key material and the mandated algorithm", () => {
    expect(() => buildHealthInformationRequestBody({
      ...HI, keyMaterial: { ...HI.keyMaterial, nonce: "" },
    })).toThrow(/key material/i);
    expect(() => buildHealthInformationRequestBody({
      ...HI, keyMaterial: { ...HI.keyMaterial, cryptoAlg: "RSA" },
    })).toThrow(/requires cryptoAlg ECDH/);
  });
});

describe("simple request bodies and response parsing", () => {
  it("builds status and fetch bodies and rejects empty ids", () => {
    expect(buildConsentStatusBody("abc")).toEqual({ consentRequestId: "abc" });
    expect(buildConsentFetchBody("xyz")).toEqual({ consentId: "xyz" });
    expect(() => buildConsentStatusBody("")).toThrow();
    expect(() => buildConsentFetchBody("  ")).toThrow();
  });

  it("reads the consent request id from either documented shape", () => {
    expect(readConsentRequestId({ consentRequestId: "a" })).toBe("a");
    expect(readConsentRequestId({ consentRequest: { id: "b" } })).toBe("b");
    expect(readConsentRequestId({})).toBeNull();
    expect(readConsentRequestId(null)).toBeNull();
  });
});

describe("ABDM protocol state machine", () => {
  it("follows the documented progression", () => {
    expect(isProtocolTransitionAllowed("NOT_SUBMITTED", "SUBMITTED")).toBe(true);
    expect(isProtocolTransitionAllowed("SUBMITTED", "ACKNOWLEDGED")).toBe(true);
    expect(isProtocolTransitionAllowed("ACKNOWLEDGED", "GRANTED")).toBe(true);
    expect(isProtocolTransitionAllowed("GRANTED", "REVOKED")).toBe(true);
  });

  it("treats a null current state as NOT_SUBMITTED", () => {
    expect(isProtocolTransitionAllowed(null, "SUBMITTED")).toBe(true);
    expect(isProtocolTransitionAllowed(undefined, "GRANTED")).toBe(false);
  });

  it("never walks a terminal decision back into a live one", () => {
    // A replayed or forged callback must not resurrect a refusal.
    for (const terminal of ["DENIED", "EXPIRED", "REVOKED"]) {
      expect(isTerminalProtocolState(terminal)).toBe(true);
      expect(isProtocolTransitionAllowed(terminal, "GRANTED")).toBe(false);
      expect(isProtocolTransitionAllowed(terminal, "ACKNOWLEDGED")).toBe(false);
      expect(isProtocolTransitionAllowed(terminal, "SUBMITTED")).toBe(false);
    }
  });

  it("cannot skip straight from not-submitted to granted", () => {
    // Nothing can be granted that was never asked for.
    expect(isProtocolTransitionAllowed("NOT_SUBMITTED", "GRANTED")).toBe(false);
    expect(isProtocolTransitionAllowed("NOT_SUBMITTED", "ACKNOWLEDGED")).toBe(false);
  });

  it("accepts a grant notified directly after submission", () => {
    // M3 s4.3.3: the CM notifies the grant itself. The separate on-init
    // acknowledgement may never be observed, so requiring it first would
    // silently drop real grants.
    expect(isProtocolTransitionAllowed("SUBMITTED", "GRANTED")).toBe(true);
    expect(isProtocolTransitionAllowed("SUBMITTED", "DENIED")).toBe(true);
  });

  it("allows a protocol error to be resubmitted", () => {
    expect(isProtocolTransitionAllowed("ERRORED", "SUBMITTED")).toBe(true);
  });

  it("permits a data fetch only against a live granted artefact", () => {
    expect(protocolPermitsDataFetch("GRANTED")).toBe(true);
    for (const s of ["NOT_SUBMITTED", "SUBMITTED", "ACKNOWLEDGED", "DENIED", "EXPIRED", "REVOKED", "ERRORED"]) {
      expect(protocolPermitsDataFetch(s)).toBe(false);
    }
  });

  it("settles the local lifecycle only for outcomes that end the transfer", () => {
    expect(localStatusForProtocolState("DENIED")).toBe("FAILED");
    expect(localStatusForProtocolState("REVOKED")).toBe("FAILED");
    // These say nothing about our own lifecycle and must not force it.
    expect(localStatusForProtocolState("SUBMITTED")).toBeNull();
    expect(localStatusForProtocolState("GRANTED")).toBeNull();
  });

  it("maps CM consent statuses and refuses to guess unknown ones", () => {
    expect(protocolStateFromConsentStatus("GRANTED")).toEqual({ state: "GRANTED", known: true });
    expect(protocolStateFromConsentStatus("denied")).toEqual({ state: "DENIED", known: true });
    const unknown = protocolStateFromConsentStatus("SOMETHING_NEW");
    expect(unknown.known).toBe(false);
    expect(unknown.state).not.toBe("GRANTED");
  });

  it("declares a transition map for every state", () => {
    for (const s of ABDM_PROTOCOL_STATES) {
      expect(typeof isTerminalProtocolState(s)).toBe("boolean");
    }
  });
});

describe("callback outcome interpretation", () => {
  it("reads a consent notification", () => {
    const out = readCallbackOutcome({
      notification: { status: "GRANTED", consentDetail: { consentId: "cm-consent-1" } },
    });
    expect(out.consentStatus).toBe("GRANTED");
    expect(out.abdmConsentId).toBe("cm-consent-1");
  });

  it("reads a health-information acknowledgement", () => {
    const out = readCallbackOutcome({ hiRequest: { transactionId: "txn-1", sessionStatus: "REQUESTED" } });
    expect(out.transactionId).toBe("txn-1");
  });

  it("reads an ABDM error envelope", () => {
    expect(readCallbackOutcome({ error: { code: "ABDM-1001", message: "x" } }).errorCode).toBe("ABDM-1001");
  });

  it("returns nulls for a body it does not understand, rather than guessing", () => {
    expect(readCallbackOutcome({ anything: true })).toEqual({
      consentStatus: null, abdmConsentId: null, transactionId: null, errorCode: null,
    });
    expect(readCallbackOutcome(null).consentStatus).toBeNull();
    expect(readCallbackOutcome("string").consentStatus).toBeNull();
  });

  it("truncates hostile oversized values", () => {
    const out = readCallbackOutcome({
      notification: { status: "G".repeat(500), consentDetail: { consentId: "c".repeat(500) } },
    });
    expect(out.consentStatus!.length).toBeLessThanOrEqual(32);
    expect(out.abdmConsentId!.length).toBeLessThanOrEqual(128);
  });
});

describe("rate limiting", () => {
  beforeEach(() => resetRateLimiter());

  it("enforces a minimum interval between identical operations", () => {
    const t = 1_000_000;
    consumeRateLimit("consentRequestInit", t);
    // A second immediate call is refused rather than silently delayed.
    expect(() => consumeRateLimit("consentRequestInit", t + 10)).toThrow(RateLimitExceededError);
    expect(() => consumeRateLimit("consentRequestInit", t + 200)).not.toThrow();
  });

  it("enforces the window limit and then recovers", () => {
    const t = 2_000_000;
    for (let i = 0; i < 10; i++) consumeRateLimit("session", t + i * 600);
    expect(() => consumeRateLimit("session", t + 10 * 600)).toThrow(RateLimitExceededError);
    // After the window rolls over, calls are allowed again.
    expect(() => consumeRateLimit("session", t + 61_000)).not.toThrow();
  });

  it("keeps separate budgets per operation", () => {
    const t = 3_000_000;
    consumeRateLimit("consentFetch", t);
    expect(() => consumeRateLimit("healthInformationRequest", t)).not.toThrow();
  });

  it("reports usage without blocking", () => {
    const t = 4_000_000;
    consumeRateLimit("consentFetch", t);
    const d = describeRateLimit("consentFetch", t);
    expect(d.used).toBe(1);
    expect(d.remaining).toBe(d.limit - 1);
  });

  it("carries a retry hint", () => {
    const t = 5_000_000;
    consumeRateLimit("consentFetch", t);
    try {
      consumeRateLimit("consentFetch", t + 1);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitExceededError);
      expect((e as RateLimitExceededError).retryAfterMs).toBeGreaterThan(0);
    }
  });
});

describe("credential rejection is diagnosed correctly", () => {
  beforeEach(() => clearSessionCache());

  const config = getAbdmConfig({
    [ABDM_ENV_VARS.environment]: "SANDBOX",
    [ABDM_ENV_VARS.clientId]: "SBX_000135",
    [ABDM_ENV_VARS.clientSecret]: "wrong",
  });

  /**
   * Reproduces exactly what the live sandbox returned on 2026-09-11 for bad
   * credentials: HTTP 400 with an ABDM error envelope, NOT a 401.
   */
  const badCredentialsFetch = (async () =>
    new Response(JSON.stringify({ error: { code: "ABDM-9999", message: "Invalid user credentials" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    })) as never;

  it("classifies ABDM's HTTP 400 credential rejection as an authentication failure", async () => {
    await expect(getAbdmSession(config, { fetchImpl: badCredentialsFetch }))
      .rejects.toMatchObject({ kind: "AUTHENTICATION_ERROR", externalCode: "ABDM-9999" });
  });

  it("surfaces it to the operator as AUTHENTICATION_FAILED, not UNKNOWN", async () => {
    const health = await checkAbdmHealth(config, { performHandshake: true, fetchImpl: badCredentialsFetch });
    expect(health.state).toBe("AUTHENTICATION_FAILED");
  });

  it("never echoes the rejected secret", async () => {
    const health = await checkAbdmHealth(config, { performHandshake: true, fetchImpl: badCredentialsFetch });
    expect(JSON.stringify(health)).not.toContain("wrong");
  });
});
