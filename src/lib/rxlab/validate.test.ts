import { describe, it, expect } from "vitest";
import { validatePrescription } from "./validate";
import type { PrescriptionContext } from "@/types/clinicalCase";
import type { PrescriptionEntry } from "@/lib/caseEngine/types";

const CONTEXT: PrescriptionContext = {
  allergies: ["penicillin"],
  pregnancyStatus: "pregnant",
  renalFunction: "failure",
  hepaticFunction: "normal",
  currentMedications: ["metformin"],
  diagnoses: [],
};

function drug(overrides: Partial<PrescriptionEntry>): PrescriptionEntry {
  return {
    drug: "Test drug", genericName: "test", formulation: "tablet", strength: "500mg",
    dose: "1", route: "oral", frequency: "OD", duration: "5 days", indication: "test",
    ...overrides,
  };
}

describe("validatePrescription", () => {
  it("flags an allergy conflict", () => {
    const warnings = validatePrescription([drug({ drug: "Amoxicillin", genericName: "penicillin" })], CONTEXT);
    expect(warnings.some((w) => w.code === "allergy-conflict" && w.severity === "danger")).toBe(true);
  });

  it("flags duplicate therapy within the same prescription", () => {
    const warnings = validatePrescription(
      [drug({ genericName: "ibuprofen" }), drug({ genericName: "ibuprofen" })],
      { ...CONTEXT, allergies: [], renalFunction: "normal" }
    );
    expect(warnings.some((w) => w.code === "duplicate-therapy")).toBe(true);
  });

  it("flags renal caution drugs when renal function is impaired", () => {
    const warnings = validatePrescription([drug({ genericName: "metformin" })], { ...CONTEXT, allergies: [] });
    expect(warnings.some((w) => w.code === "renal-consideration" && w.severity === "danger")).toBe(true);
  });

  it("flags pregnancy-contraindicated drugs", () => {
    const warnings = validatePrescription([drug({ genericName: "warfarin" })], { ...CONTEXT, allergies: [], renalFunction: "normal" });
    expect(warnings.some((w) => w.code === "pregnancy-consideration")).toBe(true);
  });

  it("flags overlap with an existing medication", () => {
    const warnings = validatePrescription([drug({ genericName: "metformin" })], { ...CONTEXT, allergies: [], renalFunction: "normal" });
    expect(warnings.some((w) => w.code === "duplicate-therapy" && w.message.includes("already documented"))).toBe(true);
  });

  it("flags a missing route", () => {
    const warnings = validatePrescription([drug({ genericName: "paracetamol", route: "" })], { ...CONTEXT, allergies: [], renalFunction: "normal" });
    expect(warnings.some((w) => w.code === "route-error")).toBe(true);
  });

  it("returns no warnings for a safe, complete, non-conflicting prescription", () => {
    const warnings = validatePrescription(
      [drug({ genericName: "paracetamol" })],
      { allergies: [], renalFunction: "normal", hepaticFunction: "normal", currentMedications: [], diagnoses: [] }
    );
    expect(warnings).toHaveLength(0);
  });
});
