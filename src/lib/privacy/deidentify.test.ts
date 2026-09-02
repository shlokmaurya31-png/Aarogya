import { describe, it, expect } from "vitest";
import { deidentifyRecord, type RawClinicalRecord } from "./deidentify";
import { ageToBand } from "./educationalIdentity";

const RAW: RawClinicalRecord = {
  patientName: "Ramesh Kumar",
  patientId: "MRN-88213",
  aadhaar: "1234 5678 9012",
  abhaNumber: "12-3456-7890-1234",
  phone: "+91 9876543210",
  email: "ramesh.kumar@example.com",
  address: "12 MG Road, Bengaluru",
  exactAge: 47,
  sex: "male",
  admissionDateIso: "2026-01-15",
  facilityName: "Fortis Hospital, Bengaluru",
  roomBed: "ICU-4",
  clinicianNotes: "Patient Ramesh Kumar (MRN-88213), reachable at 9876543210 or ramesh.kumar@example.com.",
};

describe("deidentifyRecord", () => {
  it("removes every direct identifier field name", () => {
    const result = deidentifyRecord(RAW);
    expect(result.identifiersRemoved).toEqual(
      expect.arrayContaining(["patientName", "patientId", "aadhaar", "abhaNumber", "phone", "email", "address", "facilityName", "roomBed"])
    );
  });

  it("generalizes age into a band by default, without an exact age", () => {
    const result = deidentifyRecord(RAW);
    expect(result.ageBand).toBe(ageToBand(47));
    expect(result.exactAgeIfClinicallyRequired).toBeUndefined();
  });

  it("only includes an exact age when explicitly required", () => {
    const result = deidentifyRecord(RAW, { requireExactAge: true });
    expect(result.exactAgeIfClinicallyRequired).toBe(47);
  });

  it("redacts phone/email patterns out of free-text notes", () => {
    const result = deidentifyRecord(RAW);
    expect(result.sanitizedNotes).not.toContain("9876543210");
    expect(result.sanitizedNotes).not.toContain("ramesh.kumar@example.com");
  });

  it("never returns the real facility name", () => {
    const result = deidentifyRecord(RAW);
    expect(result.facilityGeneralized).not.toContain("Fortis");
  });

  it("flags rare-disease cases for stronger privacy controls", () => {
    const result = deidentifyRecord({ ...RAW, rareDiseaseFlag: true });
    expect(result.strongerPrivacyControls).toBe(true);
  });
});
