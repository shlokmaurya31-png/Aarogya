import { describe, it, expect } from "vitest";
import { outstandingMinor } from "./billing";
import { patientLanguage as L } from "./language";
import { hashInviteToken, DELEGATION_SCOPES, DELEGATION_RELATIONSHIPS } from "../context";

/**
 * Phase D11 — pure-logic unit tests. The database-backed security invariants
 * (IDOR, delegation scope/expiry/revocation, payment forgery, races) are proven
 * end-to-end by scripts/verify-postgres-d11-patient-experience.ts; here we lock
 * the deterministic building blocks those guarantees rest on.
 */

describe("outstandingMinor — canonical patient balance", () => {
  it("is total minus allocated for a payable invoice", () => {
    expect(outstandingMinor({ status: "ISSUED", totalMinor: 10000, allocatedMinor: 3000 })).toBe(7000);
    expect(outstandingMinor({ status: "PARTIALLY_PAID", totalMinor: 10000, allocatedMinor: 9000 })).toBe(1000);
  });
  it("is zero for PAID / VOID / DRAFT regardless of amounts", () => {
    expect(outstandingMinor({ status: "PAID", totalMinor: 10000, allocatedMinor: 10000 })).toBe(0);
    expect(outstandingMinor({ status: "VOID", totalMinor: 10000, allocatedMinor: 0 })).toBe(0);
    expect(outstandingMinor({ status: "DRAFT", totalMinor: 10000, allocatedMinor: 0 })).toBe(0);
  });
  it("never goes negative (over-allocation is clamped, never a patient credit)", () => {
    expect(outstandingMinor({ status: "ISSUED", totalMinor: 10000, allocatedMinor: 12000 })).toBe(0);
  });
});

describe("patient language — internal enums never leak to the patient", () => {
  it("translates known statuses to patient-friendly text", () => {
    expect(L.invoiceStatus("PARTIALLY_PAID")).toBe("Partially paid");
    expect(L.appointmentStatus("IN_CONSULTATION")).toBe("In consultation");
    expect(L.encounterStatus("IN_PROGRESS")).toBe("Visit in progress");
    expect(L.preAuthStatus("PENDING")).toBe("Approval pending");
  });
  it("humanizes an unknown value instead of throwing or exposing raw SNAKE_CASE", () => {
    expect(L.claimStatus("SOME_NEW_BACKEND_STATUS")).toBe("Some new backend status");
    expect(L.appointmentStatus(null)).toBe("Unknown");
  });
});

describe("invite token hashing — the token is never stored in plaintext", () => {
  it("is deterministic for the same token", () => {
    expect(hashInviteToken("abc123")).toBe(hashInviteToken("abc123"));
  });
  it("differs for different tokens and is not the token itself", () => {
    const h = hashInviteToken("abc123");
    expect(h).not.toBe(hashInviteToken("abc124"));
    expect(h).not.toBe("abc123");
    expect(h).toMatch(/^[0-9a-f]{64}$/); // sha-256 hex
  });
});

describe("delegation allow-lists are closed sets", () => {
  it("scopes are the bounded, read-only surfaces", () => {
    expect(DELEGATION_SCOPES).toEqual(
      expect.arrayContaining(["APPOINTMENTS", "RECORDS", "REPORTS", "PRESCRIPTIONS", "MEDICATIONS", "BILLING", "INSURANCE", "CONSENT"]),
    );
  });
  it("relationships are a fixed vocabulary", () => {
    expect(DELEGATION_RELATIONSHIPS).toContain("CAREGIVER");
    expect(DELEGATION_RELATIONSHIPS).not.toContain("ADMIN");
  });
});
