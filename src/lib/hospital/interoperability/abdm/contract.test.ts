import { describe, it, expect } from "vitest";
import {
  ABDM_CONTRACT_SOURCE, ABDM_ENVIRONMENTS, ABDM_ENDPOINTS, ABDM_HEADERS,
  ABDM_PURPOSE_CODES, ABDM_HI_TYPES, ABDM_GRANT_TYPE, ABDM_CRYPTO,
  isValidAbhaAddress, isValidAbhaNumber, abhaAddressMatchesEnvironment, buildUrl,
} from "./contract";

/**
 * Phase C2 — these tests pin the VERIFIED ABDM contract.
 *
 * They are not testing our logic; they are a tripwire. If somebody later edits
 * an endpoint path, a header name or a purpose code to make something "work",
 * these fail and force them to go back to the official document instead of
 * drifting the contract to fit the code.
 *
 * Source: ABDM Milestone 3 Sandbox Documentation v2.5 (2025-03-03).
 */

describe("contract provenance", () => {
  it("records exactly which document these constants came from", () => {
    expect(ABDM_CONTRACT_SOURCE.version).toBe("2.5");
    expect(ABDM_CONTRACT_SOURCE.createdOn).toBe("2025-03-03");
    expect(ABDM_CONTRACT_SOURCE.url).toContain("sandboxcms.abdm.gov.in");
    expect(ABDM_CONTRACT_SOURCE.verifiedOn).toBeTruthy();
  });
});

describe("environments", () => {
  it("pins the documented base URLs and consent-manager suffixes", () => {
    expect(ABDM_ENVIRONMENTS.SANDBOX.baseUrl).toBe("https://dev.abdm.gov.in");
    expect(ABDM_ENVIRONMENTS.SANDBOX.cmId).toBe("sbx");
    expect(ABDM_ENVIRONMENTS.PRODUCTION.baseUrl).toBe("https://apis.abdm.gov.in");
    expect(ABDM_ENVIRONMENTS.PRODUCTION.cmId).toBe("abdm");
  });

  it("keeps sandbox and production genuinely distinct", () => {
    expect(ABDM_ENVIRONMENTS.SANDBOX.baseUrl).not.toBe(ABDM_ENVIRONMENTS.PRODUCTION.baseUrl);
    expect(ABDM_ENVIRONMENTS.SANDBOX.abhaSuffix).not.toBe(ABDM_ENVIRONMENTS.PRODUCTION.abhaSuffix);
  });
});

describe("endpoints", () => {
  it("pins the v3 gateway and consent paths", () => {
    expect(ABDM_ENDPOINTS.session).toBe("/api/hiecm/gateway/v3/sessions");
    expect(ABDM_ENDPOINTS.certs).toBe("/api/hiecm/gateway/v3/certs");
    expect(ABDM_ENDPOINTS.consentRequestInit).toBe("/api/hiecm/consent/v3/request/init");
    expect(ABDM_ENDPOINTS.healthInformationRequest).toBe("/api/hiecm/data-flow/v3/health-information/request");
  });

  it("uses only v3 paths, so no v0.5 endpoint can creep back in", () => {
    for (const path of Object.values(ABDM_ENDPOINTS)) {
      expect(path.startsWith("/api/hiecm/")).toBe(true);
      expect(path).toContain("/v3/");
    }
  });
});

describe("headers", () => {
  it("pins the exact header spellings the gateway requires", () => {
    expect(ABDM_HEADERS.requestId).toBe("REQUEST-ID");
    expect(ABDM_HEADERS.timestamp).toBe("TIMESTAMP");
    expect(ABDM_HEADERS.cmId).toBe("X-CM-ID");
    expect(ABDM_HEADERS.hiuId).toBe("X-HIU-ID");
    expect(ABDM_HEADERS.hipId).toBe("X-HIP-ID");
  });
});

describe("vocabularies", () => {
  it("pins the six official consent purpose codes", () => {
    expect(Object.keys(ABDM_PURPOSE_CODES).sort()).toEqual(
      ["BTG", "CAREMGT", "DSRCH", "HPAYMT", "PATRQT", "PUBHLTH"]
    );
    expect(ABDM_PURPOSE_CODES.CAREMGT.text).toBe("Care Management");
  });

  it("pins the seven official hiTypes", () => {
    expect([...ABDM_HI_TYPES].sort()).toEqual([
      "DiagnosticReport", "DischargeSummary", "HealthDocumentRecord",
      "ImmunizationRecord", "OPConsultation", "Prescription", "WellnessRecord",
    ]);
  });

  it("pins the grant type and crypto parameters", () => {
    expect(ABDM_GRANT_TYPE).toBe("client_credentials");
    expect(ABDM_CRYPTO.algorithm).toBe("ECDH");
    expect(ABDM_CRYPTO.curve).toBe("curve25519");
  });
});

describe("identifier validation", () => {
  it("accepts a well-formed ABHA address and rejects malformed ones", () => {
    expect(isValidAbhaAddress("someone@sbx")).toBe(true);
    expect(isValidAbhaAddress("some.one-1@abdm")).toBe(true);
    expect(isValidAbhaAddress("nosuffix")).toBe(false);
    expect(isValidAbhaAddress("@sbx")).toBe(false);
    expect(isValidAbhaAddress("a@")).toBe(false);
  });

  it("accepts an ABHA number with or without separators", () => {
    expect(isValidAbhaNumber("12-3456-7890-1234")).toBe(true);
    expect(isValidAbhaNumber("12345678901234")).toBe(true);
    expect(isValidAbhaNumber("123")).toBe(false);
    expect(isValidAbhaNumber("ab-cdef-ghij-klmn")).toBe(false);
  });

  it("catches an ABHA address used against the wrong environment", () => {
    // A @sbx handle in production is a silent identity failure if not caught.
    expect(abhaAddressMatchesEnvironment("someone@sbx", "SANDBOX")).toBe(true);
    expect(abhaAddressMatchesEnvironment("someone@sbx", "PRODUCTION")).toBe(false);
    expect(abhaAddressMatchesEnvironment("someone@abdm", "PRODUCTION")).toBe(true);
    expect(abhaAddressMatchesEnvironment("someone@abdm", "SANDBOX")).toBe(false);
  });
});

describe("buildUrl", () => {
  it("joins base and path without duplicating slashes", () => {
    expect(buildUrl("https://dev.abdm.gov.in/", ABDM_ENDPOINTS.session))
      .toBe("https://dev.abdm.gov.in/api/hiecm/gateway/v3/sessions");
  });

  it("substitutes and encodes path parameters", () => {
    expect(buildUrl("https://x.test", "/a/{serviceId}/b", { serviceId: "IN0210 0001" }))
      .toBe("https://x.test/a/IN0210%200001/b");
  });
});
