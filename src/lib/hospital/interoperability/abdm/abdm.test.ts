import { describe, it, expect, beforeEach } from "vitest";
import { getAbdmConfig, checkEnvironmentSafety, describeAbdmConfig, ABDM_ENV_VARS } from "./config";
import {
  InteropError, kindFromHttpStatus, isRetryableKind, readAbdmErrorEnvelope,
  fromHttpResponse, fromTransportException, toPublicError, INTEROP_ERROR_KINDS,
} from "./errors";
import { abdmRequest, buildHeaders, describeRequest } from "./transport";
import { getAbdmSession, withAbdmSession, clearSessionCache, describeCachedSession } from "./session";
import { checkAbdmHealth, isConnected } from "./health";
import {
  mapPurposeToAbdm, mapScopesToHiTypes, mapHiTypeToScopes,
  mapAbdmConsentState, reconcileConsentStatus,
} from "./mapping";
import {
  authenticateCallback, validateCallbackTimestamp, extractExternalRequestId,
  CALLBACK_MAX_SKEW_MS,
} from "./callbacks";
import { createMockAbdmFetch, isMockPayload, MOCK_MARKER } from "../adapters/mockAbdm";
import { ABDM_HEADERS } from "./contract";

/**
 * Phase C2 — configuration, transport, session, error, mapping and callback
 * behaviour.
 *
 * The load-bearing assertions are the honesty ones: an unconfigured adapter can
 * never look ready, a mock can never look like a connection, and a failure that
 * cannot succeed on retry is never marked retryable.
 */

const SANDBOX_ENV = {
  [ABDM_ENV_VARS.environment]: "SANDBOX",
  [ABDM_ENV_VARS.clientId]: "SBX_000135",
  [ABDM_ENV_VARS.clientSecret]: "test-secret-value",
};

beforeEach(() => clearSessionCache());

describe("configuration", () => {
  it("defaults to DISABLED and reports nothing configured", () => {
    const c = getAbdmConfig({});
    expect(c.environment).toBe("DISABLED");
    expect(c.configured).toBe(false);
    expect(c.baseUrl).toBeNull();
  });

  it("treats an unrecognised environment as DISABLED rather than guessing", () => {
    expect(getAbdmConfig({ [ABDM_ENV_VARS.environment]: "prod" }).environment).toBe("DISABLED");
    expect(getAbdmConfig({ [ABDM_ENV_VARS.environment]: "staging" }).environment).toBe("DISABLED");
  });

  it("resolves the documented base URL and cmId from the environment name", () => {
    const c = getAbdmConfig(SANDBOX_ENV);
    expect(c.baseUrl).toBe("https://dev.abdm.gov.in");
    expect(c.cmId).toBe("sbx");
    expect(c.configured).toBe(true);
  });

  it("reports exactly which credentials are missing", () => {
    const c = getAbdmConfig({ [ABDM_ENV_VARS.environment]: "SANDBOX" });
    expect(c.configured).toBe(false);
    expect(c.missing).toEqual([ABDM_ENV_VARS.clientId, ABDM_ENV_VARS.clientSecret]);
  });

  it("warns about a client id that is not shaped like a bridge id", () => {
    const c = getAbdmConfig({ ...SANDBOX_ENV, [ABDM_ENV_VARS.clientId]: "not-a-bridge" });
    expect(c.warnings.join(" ")).toMatch(/bridge id/i);
  });

  it("refuses to treat a plaintext callback URL as configured", () => {
    const c = getAbdmConfig({
      ...SANDBOX_ENV,
      [ABDM_ENV_VARS.callbackBaseUrl]: "http://insecure.example",
      [ABDM_ENV_VARS.callbackToken]: "token",
    });
    expect(c.callbacksConfigured).toBe(false);
    expect(c.warnings.join(" ")).toMatch(/https/i);
  });

  it("warns when a callback URL is set without a callback token", () => {
    const c = getAbdmConfig({ ...SANDBOX_ENV, [ABDM_ENV_VARS.callbackBaseUrl]: "https://ok.example" });
    expect(c.callbacksConfigured).toBe(false);
    expect(c.warnings.join(" ")).toMatch(/callbacks will be refused/i);
  });

  it("clamps an absurd timeout into a sane range", () => {
    expect(getAbdmConfig({ ...SANDBOX_ENV, [ABDM_ENV_VARS.requestTimeoutMs]: "1" }).requestTimeoutMs).toBe(1000);
    expect(getAbdmConfig({ ...SANDBOX_ENV, [ABDM_ENV_VARS.requestTimeoutMs]: "99999999" }).requestTimeoutMs).toBe(120000);
    expect(getAbdmConfig({ ...SANDBOX_ENV, [ABDM_ENV_VARS.requestTimeoutMs]: "abc" }).requestTimeoutMs).toBe(30000);
  });

  it("never exposes the client id, secret or callback token", () => {
    const described = describeAbdmConfig(getAbdmConfig({
      ...SANDBOX_ENV,
      [ABDM_ENV_VARS.callbackToken]: "super-secret-callback-token",
    }));
    const json = JSON.stringify(described);
    expect(json).not.toContain("test-secret-value");
    expect(json).not.toContain("super-secret-callback-token");
    expect(json).not.toContain("SBX_000135");
  });
});

describe("environment safety — production fails closed", () => {
  it("flags production pointed at sandbox and vice versa", () => {
    expect(checkEnvironmentSafety(getAbdmConfig(SANDBOX_ENV), "production").safe).toBe(false);
    const prod = getAbdmConfig({ ...SANDBOX_ENV, [ABDM_ENV_VARS.environment]: "PRODUCTION" });
    expect(checkEnvironmentSafety(prod, "development").safe).toBe(false);
  });

  it("refuses a PRODUCTION selection that is missing credentials", () => {
    const cfg = getAbdmConfig({ [ABDM_ENV_VARS.environment]: "PRODUCTION" });
    const r = checkEnvironmentSafety(cfg, "production");
    expect(r.safe).toBe(false);
    expect(r.warning).toMatch(/not set/);
  });

  it("treats DISABLED as safe everywhere", () => {
    expect(checkEnvironmentSafety(getAbdmConfig({}), "production").safe).toBe(true);
  });
});

describe("error model", () => {
  it("maps HTTP statuses onto the internal vocabulary", () => {
    expect(kindFromHttpStatus(400)).toBe("VALIDATION_ERROR");
    expect(kindFromHttpStatus(401)).toBe("AUTHENTICATION_ERROR");
    expect(kindFromHttpStatus(403)).toBe("AUTHORIZATION_ERROR");
    expect(kindFromHttpStatus(429)).toBe("RATE_LIMITED");
    expect(kindFromHttpStatus(503)).toBe("EXTERNAL_SERVER_ERROR");
  });

  it("marks only genuinely transient failures retryable", () => {
    for (const kind of ["TIMEOUT", "NETWORK_ERROR", "EXTERNAL_SERVER_ERROR", "RATE_LIMITED"] as const) {
      expect(isRetryableKind(kind)).toBe(true);
    }
    // Retrying any of these unchanged cannot succeed, and for a partially
    // applied disclosure it could duplicate one.
    for (const kind of ["VALIDATION_ERROR", "AUTHORIZATION_ERROR", "CONSENT_ERROR", "IDENTITY_ERROR", "CONFIGURATION_ERROR", "AUTHENTICATION_ERROR", "CALLBACK_ERROR", "CONFLICT", "NOT_FOUND"] as const) {
      expect(isRetryableKind(kind)).toBe(false);
    }
  });

  it("covers every declared kind in the retry policy", () => {
    for (const kind of INTEROP_ERROR_KINDS) {
      expect(typeof isRetryableKind(kind)).toBe("boolean");
    }
  });

  it("reads the ABDM error envelope defensively", () => {
    expect(readAbdmErrorEnvelope({ error: { code: "ABDM-1001", message: "boom" } }))
      .toEqual({ code: "ABDM-1001", message: "boom" });
    expect(readAbdmErrorEnvelope(null)).toEqual({ code: null, message: null });
    expect(readAbdmErrorEnvelope({ error: "nope" })).toEqual({ code: null, message: null });
  });

  it("truncates a hostile external message so it cannot flood a log", () => {
    const long = readAbdmErrorEnvelope({ error: { code: "X".repeat(200), message: "y".repeat(5000) } });
    expect(long.code!.length).toBeLessThanOrEqual(64);
    expect(long.message!.length).toBeLessThanOrEqual(300);
  });

  it("classifies transport exceptions without echoing internals", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(fromTransportException({ error: abort, operation: "session" }).kind).toBe("TIMEOUT");
    const dns = Object.assign(new Error("getaddrinfo ENOTFOUND dev.abdm.gov.in"), { code: "ENOTFOUND" });
    const netErr = fromTransportException({ error: dns, operation: "session" });
    expect(netErr.kind).toBe("NETWORK_ERROR");
    expect(netErr.message).not.toContain("getaddrinfo");
  });

  it("keeps the public projection free of internal detail", () => {
    const err = fromHttpResponse({ status: 403, body: { error: { code: "ABDM-1403", message: "no consent" } }, operation: "consent" });
    const pub = toPublicError(err);
    expect(pub.kind).toBe("AUTHORIZATION_ERROR");
    expect(pub.externalCode).toBe("ABDM-1403");
    expect(Object.keys(pub)).toEqual(["kind", "message", "externalCode", "retryable", "requestId"]);
  });
});

describe("transport", () => {
  const config = getAbdmConfig(SANDBOX_ENV);

  it("sends the mandatory ABDM headers", () => {
    const headers = buildHeaders(config, { requestId: "rid-1", accessToken: "tok", hiuId: "HIU1" });
    expect(headers[ABDM_HEADERS.requestId]).toBe("rid-1");
    expect(headers[ABDM_HEADERS.cmId]).toBe("sbx");
    expect(headers[ABDM_HEADERS.hiuId]).toBe("HIU1");
    expect(headers[ABDM_HEADERS.authorization]).toBe("Bearer tok");
    expect(Date.parse(headers[ABDM_HEADERS.timestamp])).not.toBeNaN();
  });

  it("redacts the Authorization header when describing a request", () => {
    const headers = buildHeaders(config, { accessToken: "super-secret-token" });
    const described = describeRequest("https://x", headers);
    expect(JSON.stringify(described)).not.toContain("super-secret-token");
    expect(described.headers.join(" ")).toContain("(redacted)");
  });

  it("refuses to call when ABDM is disabled", async () => {
    await expect(abdmRequest({
      config: getAbdmConfig({}), path: "/x", operation: "test", fetchImpl: createMockAbdmFetch(),
    })).rejects.toMatchObject({ kind: "CONFIGURATION_ERROR" });
  });

  it("classifies a malformed gateway body instead of trusting it", async () => {
    await expect(abdmRequest({
      config, path: "/x", operation: "test", fetchImpl: createMockAbdmFetch("MALFORMED_BODY"),
    })).rejects.toMatchObject({ kind: "UNKNOWN_EXTERNAL_ERROR" });
  });

  it("maps gateway failures through the error model", async () => {
    const cases = [
      ["VALIDATION_FAILURE", "VALIDATION_ERROR"],
      ["AUTH_FAILURE", "AUTHENTICATION_ERROR"],
      ["CONSENT_FAILURE", "AUTHORIZATION_ERROR"],
      ["RATE_LIMITED", "RATE_LIMITED"],
      ["SERVER_ERROR", "EXTERNAL_SERVER_ERROR"],
      ["TIMEOUT", "TIMEOUT"],
      ["NETWORK_ERROR", "NETWORK_ERROR"],
      ["DUPLICATE_REQUEST", "CONFLICT"],
    ] as const;
    for (const [scenario, kind] of cases) {
      await expect(abdmRequest({
        config, path: "/x", operation: "test", fetchImpl: createMockAbdmFetch(scenario),
      })).rejects.toMatchObject({ kind });
    }
  });
});

describe("session — system authentication, not user authentication", () => {
  const config = getAbdmConfig(SANDBOX_ENV);

  it("refuses to authenticate when disabled or unconfigured", async () => {
    await expect(getAbdmSession(getAbdmConfig({}))).rejects.toMatchObject({ kind: "CONFIGURATION_ERROR" });
    await expect(getAbdmSession(getAbdmConfig({ [ABDM_ENV_VARS.environment]: "SANDBOX" })))
      .rejects.toMatchObject({ kind: "CONFIGURATION_ERROR" });
  });

  it("obtains and caches a token", async () => {
    const fetchImpl = createMockAbdmFetch("SUCCESS");
    const first = await getAbdmSession(config, { fetchImpl });
    const second = await getAbdmSession(config, { fetchImpl });
    expect(first.accessToken).toBe(second.accessToken);
    // Cached: only ONE network call for two requests.
    expect(fetchImpl.calls.length).toBe(1);
  });

  it("re-authenticates exactly once when the gateway rejects the token", async () => {
    const fetchImpl = createMockAbdmFetch(["SUCCESS", "SUCCESS"]);
    await getAbdmSession(config, { fetchImpl });
    let attempts = 0;
    const result = await withAbdmSession(config, async () => {
      attempts++;
      if (attempts === 1) throw new InteropError({ kind: "AUTHENTICATION_ERROR", message: "stale" });
      return "ok";
    }, { fetchImpl });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("does not retry a non-authentication failure", async () => {
    const fetchImpl = createMockAbdmFetch("SUCCESS");
    let attempts = 0;
    await expect(withAbdmSession(config, async () => {
      attempts++;
      throw new InteropError({ kind: "VALIDATION_ERROR", message: "bad request" });
    }, { fetchImpl })).rejects.toMatchObject({ kind: "VALIDATION_ERROR" });
    expect(attempts).toBe(1);
  });

  it("rejects a session response with no access token", async () => {
    const noToken = (async () => new Response(JSON.stringify({ expiresIn: 600 }), {
      status: 202, headers: { "Content-Type": "application/json" },
    })) as never;
    await expect(getAbdmSession(config, { fetchImpl: noToken }))
      .rejects.toMatchObject({ kind: "AUTHENTICATION_ERROR" });
  });

  it("describes a cached session without revealing the token", async () => {
    const fetchImpl = createMockAbdmFetch("SUCCESS");
    await getAbdmSession(config, { fetchImpl });
    const described = describeCachedSession(config);
    expect(described.cached).toBe(true);
    expect(described.valid).toBe(true);
    expect(JSON.stringify(described)).not.toMatch(/mock-access-token/);
  });
});

describe("health check — AVAILABLE requires a real handshake", () => {
  it("reports DISABLED when switched off", async () => {
    const h = await checkAbdmHealth(getAbdmConfig({}));
    expect(h.state).toBe("DISABLED");
    expect(h.handshakePerformed).toBe(false);
    expect(isConnected(h.state)).toBe(false);
  });

  it("reports MISCONFIGURED when credentials are absent", async () => {
    const h = await checkAbdmHealth(getAbdmConfig({ [ABDM_ENV_VARS.environment]: "SANDBOX" }));
    expect(h.state).toBe("MISCONFIGURED");
    expect(isConnected(h.state)).toBe(false);
  });

  it("reports UNKNOWN — never AVAILABLE — when no handshake was attempted", async () => {
    const h = await checkAbdmHealth(getAbdmConfig(SANDBOX_ENV), { performHandshake: false });
    expect(h.state).toBe("UNKNOWN");
    expect(h.handshakePerformed).toBe(false);
    expect(isConnected(h.state)).toBe(false);
  });

  it("distinguishes unreachable from rejected credentials", async () => {
    const unreachable = await checkAbdmHealth(getAbdmConfig(SANDBOX_ENV), {
      performHandshake: true, fetchImpl: createMockAbdmFetch("NETWORK_ERROR"),
    });
    expect(unreachable.state).toBe("UNREACHABLE");

    const rejected = await checkAbdmHealth(getAbdmConfig(SANDBOX_ENV), {
      performHandshake: true, fetchImpl: createMockAbdmFetch("AUTH_FAILURE"),
    });
    expect(rejected.state).toBe("AUTHENTICATION_FAILED");
  });

  it("only AVAILABLE counts as connected", async () => {
    for (const state of ["DISABLED", "MISCONFIGURED", "UNREACHABLE", "AUTHENTICATION_FAILED", "UNKNOWN"] as const) {
      expect(isConnected(state)).toBe(false);
    }
    expect(isConnected("AVAILABLE")).toBe(true);
  });
});

describe("mock adapter is unmistakably a mock", () => {
  it("labels every payload it produces", async () => {
    const fetchImpl = createMockAbdmFetch("SUCCESS");
    const res = await fetchImpl("https://dev.abdm.gov.in/api/hiecm/gateway/v3/sessions", { method: "POST" });
    const body = await res.json();
    expect(isMockPayload(body)).toBe(true);
    expect(body[MOCK_MARKER]).toBe(true);
    expect(String(body.accessToken)).toMatch(/^mock-access-token-/);
  });
});

describe("local ↔ ABDM mapping", () => {
  it("maps local purposes onto the official purpose codes", () => {
    expect(mapPurposeToAbdm("TREATMENT").code).toBe("CAREMGT");
    expect(mapPurposeToAbdm("INSURANCE").code).toBe("HPAYMT");
    expect(mapPurposeToAbdm("PATIENT_ACCESS").code).toBe("PATRQT");
    expect(mapPurposeToAbdm("RESEARCH").code).toBe("DSRCH");
  });

  it("flags the purposes whose mapping loses meaning", () => {
    // TREATMENT/REFERRAL/SECOND_OPINION/OTHER all collapse to CAREMGT, so the
    // reverse direction is genuinely ambiguous and is marked as such.
    expect(mapPurposeToAbdm("TREATMENT").lossy).toBe(true);
    expect(mapPurposeToAbdm("REFERRAL").lossy).toBe(true);
    expect(mapPurposeToAbdm("INSURANCE").lossy).toBe(false);
    expect(mapPurposeToAbdm("PATIENT_ACCESS").lossy).toBe(false);
  });

  it("maps data-category scopes onto document-class hiTypes", () => {
    expect(mapScopesToHiTypes(["LAB"]).hiTypes).toEqual(["DiagnosticReport"]);
    expect(mapScopesToHiTypes(["MEDICATION"]).hiTypes).toContain("Prescription");
    expect(mapScopesToHiTypes(["ALL_CLINICAL"]).hiTypes.length).toBe(7);
  });

  it("reports BILLING as unsupported rather than silently dropping it", () => {
    const r = mapScopesToHiTypes(["BILLING"]);
    expect(r.hiTypes).toEqual([]);
    expect(r.unsupported).toEqual(["BILLING"]);
  });

  it("flags when the protocol cannot express a narrow scope", () => {
    // IMAGING maps to DiagnosticReport, which also carries lab data.
    expect(mapScopesToHiTypes(["IMAGING"]).broadened).toBe(true);
    expect(mapScopesToHiTypes(["DOCUMENTS"]).broadened).toBe(false);
  });

  it("reverses an hiType to every scope it could satisfy, not one guess", () => {
    expect(mapHiTypeToScopes("DiagnosticReport").sort()).toEqual(["IMAGING", "LAB"]);
    expect(mapHiTypeToScopes("Nonsense")).toEqual([]);
  });

  it("maps ABDM consent states, treating unknown ones as not-granted", () => {
    expect(mapAbdmConsentState("GRANTED")).toEqual({ localStatus: "GRANTED", known: true });
    expect(mapAbdmConsentState("DENIED")).toEqual({ localStatus: "DECLINED", known: true });
    const unknown = mapAbdmConsentState("SOMETHING_NEW");
    expect(unknown.known).toBe(false);
    expect(["GRANTED", "ACTIVE"]).not.toContain(unknown.localStatus);
  });
});

describe("consent status reconciliation — the external view wins", () => {
  it("allows a locally granted consent when no external view is required", () => {
    expect(reconcileConsentStatus({ localStatus: "GRANTED", externalRequired: false }).usable).toBe(true);
  });

  it("blocks when the CM reports revoked even though the local row says granted", () => {
    const r = reconcileConsentStatus({ localStatus: "GRANTED", externalStatus: "REVOKED", externalRequired: true });
    expect(r.usable).toBe(false);
    expect(r.reason).toMatch(/REVOKED/i);
  });

  it("blocks when an external status is required but has never been synchronised", () => {
    const r = reconcileConsentStatus({ localStatus: "GRANTED", externalStatus: null, externalRequired: true });
    expect(r.usable).toBe(false);
    expect(r.reason).toMatch(/not been synchronised/i);
  });

  it("blocks on an unrecognised external status rather than assuming the best", () => {
    const r = reconcileConsentStatus({ localStatus: "GRANTED", externalStatus: "WEIRD", externalRequired: true });
    expect(r.usable).toBe(false);
  });

  it("blocks when the local row is stale even if the CM says granted", () => {
    const r = reconcileConsentStatus({ localStatus: "REVOKED", externalStatus: "GRANTED", externalRequired: true });
    expect(r.usable).toBe(false);
  });

  it("allows only when both views agree", () => {
    expect(reconcileConsentStatus({ localStatus: "GRANTED", externalStatus: "GRANTED", externalRequired: true }).usable).toBe(true);
  });
});

describe("callback authentication and replay window", () => {
  const configured = getAbdmConfig({ ...SANDBOX_ENV, [ABDM_ENV_VARS.callbackToken]: "correct-token" });

  it("refuses callbacks when ABDM is disabled", () => {
    expect(() => authenticateCallback(getAbdmConfig({}), "anything")).toThrow(/disabled/i);
  });

  it("fails closed when no callback token is configured", () => {
    // An unconfigured secret must never mean "accept everyone".
    expect(() => authenticateCallback(getAbdmConfig(SANDBOX_ENV), "anything")).toThrow(/refused/i);
  });

  it("rejects a missing or wrong token", () => {
    expect(() => authenticateCallback(configured, null)).toThrow(/authentication failed/i);
    expect(() => authenticateCallback(configured, "wrong-token")).toThrow(/authentication failed/i);
    expect(() => authenticateCallback(configured, "correct-token!")).toThrow(/authentication failed/i);
  });

  it("accepts the correct token", () => {
    expect(() => authenticateCallback(configured, "correct-token")).not.toThrow();
  });

  it("rejects a missing, malformed or stale timestamp", () => {
    const now = Date.now();
    expect(() => validateCallbackTimestamp(null, now)).toThrow(/missing/i);
    expect(() => validateCallbackTimestamp("not-a-date", now)).toThrow(/valid ISO/i);
    const stale = new Date(now - CALLBACK_MAX_SKEW_MS - 60_000).toISOString();
    expect(() => validateCallbackTimestamp(stale, now)).toThrow(/outside the accepted window/i);
    const future = new Date(now + CALLBACK_MAX_SKEW_MS + 60_000).toISOString();
    expect(() => validateCallbackTimestamp(future, now)).toThrow(/outside the accepted window/i);
  });

  it("accepts a timestamp inside the window", () => {
    const now = Date.now();
    expect(() => validateCallbackTimestamp(new Date(now - 1000).toISOString(), now)).not.toThrow();
  });

  it("extracts the correlating request id from body or header", () => {
    expect(extractExternalRequestId({ response: { requestId: "abc" } }, null)).toBe("abc");
    expect(extractExternalRequestId({}, "hdr-1")).toBe("hdr-1");
    expect(extractExternalRequestId(null, null)).toBeNull();
    // Oversized values are refused rather than truncated into a false match.
    expect(extractExternalRequestId({ response: { requestId: "x".repeat(200) } }, null)).toBeNull();
  });
});
