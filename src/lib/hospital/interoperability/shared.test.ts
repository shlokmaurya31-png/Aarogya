import { describe, it, expect } from "vitest";
import {
  isTransitionAllowed, CONSENT_TRANSITIONS, EXCHANGE_TRANSITIONS,
  isConsentUsable, consentCoversScope, consentCoversAllScopes,
  assertSystemMatchesEntity, assertOneOf, maskIdentifier,
  IDENTIFIER_SYSTEMS, CONSENT_SCOPES,
} from "./shared";

/**
 * Phase C1 — consent and exchange rules. These are the authorization primitives,
 * so they are unit-tested without a database: a regression here is a disclosure
 * bug, not a cosmetic one.
 */
const DAY = 86400_000;
const future = () => new Date(Date.now() + 30 * DAY);
const past = () => new Date(Date.now() - DAY);

describe("consent lifecycle", () => {
  it("follows REQUESTED -> GRANTED -> ACTIVE -> EXPIRED", () => {
    expect(isTransitionAllowed(CONSENT_TRANSITIONS, "REQUESTED", "GRANTED")).toBe(true);
    expect(isTransitionAllowed(CONSENT_TRANSITIONS, "GRANTED", "ACTIVE")).toBe(true);
    expect(isTransitionAllowed(CONSENT_TRANSITIONS, "ACTIVE", "EXPIRED")).toBe(true);
  });

  it("allows revocation from every live state", () => {
    expect(isTransitionAllowed(CONSENT_TRANSITIONS, "GRANTED", "REVOKED")).toBe(true);
    expect(isTransitionAllowed(CONSENT_TRANSITIONS, "ACTIVE", "REVOKED")).toBe(true);
  });

  it("never allows a terminal consent to come back to life", () => {
    for (const terminal of ["REVOKED", "EXPIRED", "DECLINED", "CANCELLED"]) {
      expect(CONSENT_TRANSITIONS[terminal]).toEqual([]);
      expect(isTransitionAllowed(CONSENT_TRANSITIONS, terminal, "GRANTED")).toBe(false);
      expect(isTransitionAllowed(CONSENT_TRANSITIONS, terminal, "ACTIVE")).toBe(false);
    }
  });

  it("cannot grant a consent that was never requested", () => {
    expect(isTransitionAllowed(CONSENT_TRANSITIONS, "DECLINED", "GRANTED")).toBe(false);
  });
});

describe("isConsentUsable", () => {
  const base = { status: "GRANTED", expiresAt: null as Date | null, revokedAt: null as Date | null, grantedAt: new Date() };

  it("accepts a granted, unexpired consent", () => {
    expect(isConsentUsable({ ...base })).toBe(true);
    expect(isConsentUsable({ ...base, status: "ACTIVE", expiresAt: future() })).toBe(true);
  });

  it("rejects a revoked consent even while its status still says GRANTED", () => {
    // Revocation must win over a stale status column.
    expect(isConsentUsable({ ...base, revokedAt: new Date() })).toBe(false);
  });

  it("rejects an expired consent even if it was never swept to EXPIRED", () => {
    expect(isConsentUsable({ ...base, expiresAt: past() })).toBe(false);
  });

  it("treats the exact expiry instant as expired", () => {
    const now = new Date();
    expect(isConsentUsable({ ...base, expiresAt: now }, now)).toBe(false);
  });

  it("rejects every non-live status", () => {
    for (const status of ["REQUESTED", "DECLINED", "CANCELLED", "EXPIRED", "REVOKED"]) {
      expect(isConsentUsable({ ...base, status })).toBe(false);
    }
  });
});

describe("consent scope coverage", () => {
  it("matches an explicitly granted scope", () => {
    expect(consentCoversScope(["LAB"], "LAB")).toBe(true);
  });

  it("does not leak a neighbouring scope", () => {
    expect(consentCoversScope(["LAB"], "MEDICATION")).toBe(false);
    expect(consentCoversScope(["DIAGNOSIS"], "DOCUMENTS")).toBe(false);
  });

  it("expands ALL_CLINICAL across clinical classes", () => {
    for (const scope of ["LAB", "IMAGING", "MEDICATION", "DIAGNOSIS", "DOCUMENTS", "ENCOUNTER", "ALLERGY", "VITALS", "CARE_PLAN"]) {
      expect(consentCoversScope(["ALL_CLINICAL"], scope)).toBe(true);
    }
  });

  it("does NOT let ALL_CLINICAL imply billing", () => {
    // Financial disclosure is a separate decision from clinical disclosure.
    expect(consentCoversScope(["ALL_CLINICAL"], "BILLING")).toBe(false);
  });

  it("requires every requested scope to be covered", () => {
    expect(consentCoversAllScopes(["LAB", "MEDICATION"], ["LAB", "MEDICATION"])).toBe(true);
    expect(consentCoversAllScopes(["LAB"], ["LAB", "MEDICATION"])).toBe(false);
    expect(consentCoversAllScopes(["ALL_CLINICAL"], ["LAB", "BILLING"])).toBe(false);
  });

  it("treats an empty grant as covering nothing", () => {
    expect(consentCoversAllScopes([], ["LAB"])).toBe(false);
  });
});

describe("exchange lifecycle", () => {
  it("follows REQUESTED -> AUTHORIZED -> PROCESSING -> COMPLETED", () => {
    expect(isTransitionAllowed(EXCHANGE_TRANSITIONS, "REQUESTED", "AUTHORIZED")).toBe(true);
    expect(isTransitionAllowed(EXCHANGE_TRANSITIONS, "AUTHORIZED", "PROCESSING")).toBe(true);
    expect(isTransitionAllowed(EXCHANGE_TRANSITIONS, "PROCESSING", "COMPLETED")).toBe(true);
  });

  it("cannot dispatch without authorization", () => {
    expect(isTransitionAllowed(EXCHANGE_TRANSITIONS, "REQUESTED", "PROCESSING")).toBe(false);
    expect(isTransitionAllowed(EXCHANGE_TRANSITIONS, "REQUESTED", "COMPLETED")).toBe(false);
  });

  it("allows a failed exchange to be retried but not a completed one", () => {
    expect(isTransitionAllowed(EXCHANGE_TRANSITIONS, "FAILED", "PROCESSING")).toBe(true);
    expect(EXCHANGE_TRANSITIONS.COMPLETED).toEqual([]);
  });

  it("treats rejected and completed as terminal", () => {
    expect(isTransitionAllowed(EXCHANGE_TRANSITIONS, "REJECTED", "AUTHORIZED")).toBe(false);
    expect(isTransitionAllowed(EXCHANGE_TRANSITIONS, "COMPLETED", "PROCESSING")).toBe(false);
  });
});

describe("identifier system / entity binding", () => {
  it("accepts an ABHA on a patient and an HFR on a facility", () => {
    expect(() => assertSystemMatchesEntity(IDENTIFIER_SYSTEMS.ABHA_NUMBER, "PATIENT")).not.toThrow();
    expect(() => assertSystemMatchesEntity(IDENTIFIER_SYSTEMS.HFR, "FACILITY")).not.toThrow();
    expect(() => assertSystemMatchesEntity(IDENTIFIER_SYSTEMS.HPR, "STAFF")).not.toThrow();
  });

  it("refuses a registry identifier on the wrong kind of entity", () => {
    // An HPR professional number must never land on a patient record.
    expect(() => assertSystemMatchesEntity(IDENTIFIER_SYSTEMS.HPR, "PATIENT")).toThrow(/identifies a STAFF/);
    expect(() => assertSystemMatchesEntity(IDENTIFIER_SYSTEMS.ABHA_NUMBER, "FACILITY")).toThrow(/identifies a PATIENT/);
    expect(() => assertSystemMatchesEntity(IDENTIFIER_SYSTEMS.HFR, "STAFF")).toThrow(/identifies a FACILITY/);
  });

  it("permits unknown partner systems on any entity", () => {
    expect(() => assertSystemMatchesEntity("https://partner.example/mrn", "PATIENT")).not.toThrow();
  });
});

describe("assertOneOf", () => {
  it("accepts a known value and rejects an invented one", () => {
    expect(assertOneOf("LAB", CONSENT_SCOPES, "consent scope")).toBe("LAB");
    expect(() => assertOneOf("EVERYTHING", CONSENT_SCOPES, "consent scope")).toThrow(/Unknown consent scope/);
  });
});

describe("maskIdentifier", () => {
  it("leaves only the last four characters visible", () => {
    expect(maskIdentifier("91234567890123")).toBe("**********0123");
  });
  it("fully masks a short value and handles an empty one", () => {
    expect(maskIdentifier("1234")).toBe("****");
    expect(maskIdentifier("")).toBe("");
  });
  it("never returns the original value for a realistic ABHA number", () => {
    const abha = "12-3456-7890-1234";
    expect(maskIdentifier(abha)).not.toBe(abha);
    expect(maskIdentifier(abha).endsWith("1234")).toBe(true);
  });
});
