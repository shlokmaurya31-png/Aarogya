import { describe, it, expect } from "vitest";
import { sanitizeToEducationalCase, assertSyntheticCaseIsClean } from "./caseSanitizer";
import type { RawClinicalRecord } from "./deidentify";

const RAW: RawClinicalRecord = {
  patientName: "Sunita Verma",
  patientId: "MRN-11209",
  phone: "9876543210",
  exactAge: 34,
  sex: "female",
  admissionDateIso: "2026-02-01",
  facilityName: "Apollo Hospital",
  clinicianNotes: "Reachable at 9876543210.",
};

describe("sanitizeToEducationalCase", () => {
  it("produces a snapshot with no prohibited identifier fields", () => {
    const snapshot = sanitizeToEducationalCase("EDU-TEST-001", RAW, "female");
    expect(snapshot).not.toHaveProperty("patientId");
    expect(snapshot).not.toHaveProperty("phone");
    expect(snapshot).not.toHaveProperty("facilityName");
  });

  it("generates an educational name independent of the real name", () => {
    const snapshot = sanitizeToEducationalCase("EDU-TEST-001", RAW, "female");
    expect(snapshot.patientName).not.toBe(RAW.patientName);
  });

  it("is deterministic per case id (same case id -> same educational identity)", () => {
    const a = sanitizeToEducationalCase("EDU-TEST-042", RAW, "female");
    const b = sanitizeToEducationalCase("EDU-TEST-042", RAW, "female");
    expect(a.patientName).toBe(b.patientName);
  });
});

describe("assertSyntheticCaseIsClean", () => {
  it("passes for a clean object", () => {
    expect(() => assertSyntheticCaseIsClean({ title: "Chest pain", patientName: "Aarav Mehta" })).not.toThrow();
  });

  it("throws when a prohibited identifier field name is present", () => {
    expect(() => assertSyntheticCaseIsClean({ title: "Chest pain", patientId: "MRN-123" })).toThrow();
  });

  it("throws for a nested prohibited field", () => {
    expect(() => assertSyntheticCaseIsClean({ meta: { contact: { phone: "123" } } })).toThrow();
  });
});
