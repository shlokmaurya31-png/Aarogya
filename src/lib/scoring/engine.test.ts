import { describe, it, expect } from "vitest";
import { scoreCaseAttempt } from "./engine";
import { DEFAULT_RUBRIC } from "./defaultRubrics";
import { emptyRevealedState } from "@/lib/caseEngine/types";
import type { CaseContent } from "@/types/clinicalCase";

const CONTENT: CaseContent = {
  presentation: "Test.",
  initialVitals: { hr: 80, sbp: 120, dbp: 80, rr: 16, spo2: 98, tempC: 37, gcs: 15, status: "stable" },
  historyTree: [
    { id: "h-1", question: "Q1", category: "presenting-complaint", answer: "A1", isKeyFinding: true },
    { id: "h-2", question: "Q2", category: "associated-symptoms", answer: "A2", isKeyFinding: true },
  ],
  examFindings: [{ id: "e-1", system: "cardiovascular", finding: "F1", isKeyFinding: true }],
  investigations: [
    { id: "i-1", name: "Troponin", category: "biochemistry", indication: "ACS", turnaroundMinutes: 30, resultSummary: "High", interpretation: "MI", isDiagnostic: true },
    { id: "i-2", name: "D-dimer", category: "biochemistry", indication: "Low-yield here", turnaroundMinutes: 20, resultSummary: "Normal", interpretation: "Not useful", isDistractor: true },
  ],
  redFlags: [],
  referenceDifferentials: [
    { diagnosis: "ST-elevation myocardial infarction", rationale: "Classic presentation.", mustNotMiss: true },
    { diagnosis: "Aortic dissection", rationale: "Must exclude.", mustNotMiss: true },
  ],
  managementPathway: [
    { id: "m-1", label: "Aspirin", description: "Give aspirin.", isCritical: true },
    { id: "m-2", label: "Unsafe nitrate", description: "Give nitrate without checking BP.", isUnsafeIfChosen: true },
  ],
  criticalActions: ["Aspirin"],
  unsafeActions: ["Unsafe nitrate"],
  prescriptionContext: { allergies: ["penicillin"], renalFunction: "normal", hepaticFunction: "normal", currentMedications: [], diagnoses: [] },
  prescriptionReference: [{ genericName: "aspirin", formulation: "tablet", strength: "325mg", route: "oral", frequency: "once", duration: "once", indication: "ACS" }],
  debrief: { pearls: [], references: [] },
};

function baseInput(overrides: Partial<Parameters<typeof scoreCaseAttempt>[0]> = {}) {
  return {
    content: CONTENT,
    rubric: DEFAULT_RUBRIC,
    referenceDx: "ST-elevation myocardial infarction",
    revealed: emptyRevealedState(),
    differential: null,
    diagnosis: null,
    managementSelectedStepIds: null,
    prescriptions: null,
    hintsUsed: 0,
    ...overrides,
  };
}

describe("scoreCaseAttempt", () => {
  it("scores zero on history/exam when nothing was revealed", () => {
    const result = scoreCaseAttempt(baseInput());
    const history = result.dimensions.find((d) => d.key === "history")!;
    expect(history.earned).toBe(0);
  });

  it("awards full history credit when all key findings are revealed", () => {
    const result = scoreCaseAttempt(baseInput({ revealed: { ...emptyRevealedState(), revealedHistoryIds: ["h-1", "h-2"] } }));
    const history = result.dimensions.find((d) => d.key === "history")!;
    expect(history.earned).toBe(history.maxEarnable);
  });

  it("gives full diagnosis credit for a close paraphrase of the reference diagnosis", () => {
    const result = scoreCaseAttempt(baseInput({ diagnosis: "St elevation myocardial infarction" }));
    const dx = result.dimensions.find((d) => d.key === "diagnosis")!;
    expect(dx.earned).toBe(dx.maxEarnable);
  });

  it("penalizes ordering a distractor investigation", () => {
    const clean = scoreCaseAttempt(baseInput({ revealed: { ...emptyRevealedState(), orderedInvestigationIds: ["i-1"] } }));
    const withDistractor = scoreCaseAttempt(baseInput({ revealed: { ...emptyRevealedState(), orderedInvestigationIds: ["i-1", "i-2"] } }));
    const cleanInv = clean.dimensions.find((d) => d.key === "investigations")!;
    const distractorInv = withDistractor.dimensions.find((d) => d.key === "investigations")!;
    expect(distractorInv.earned).toBeLessThan(cleanInv.earned);
  });

  it("penalizes choosing an unsafe management action and records it", () => {
    const result = scoreCaseAttempt(baseInput({ managementSelectedStepIds: ["m-1", "m-2"] }));
    expect(result.unsafeActionsChosen).toContain("Unsafe nitrate");
    const mgmt = result.dimensions.find((d) => d.key === "management")!;
    expect(mgmt.earned).toBeLessThan(mgmt.maxEarnable);
  });

  it("flags an allergy conflict in prescription scoring", () => {
    const result = scoreCaseAttempt(
      baseInput({
        prescriptions: [{ drug: "Amoxicillin", genericName: "penicillin", formulation: "tablet", strength: "500mg", dose: "1", route: "oral", frequency: "TDS", duration: "5 days", indication: "Infection" }],
      })
    );
    const safety = result.dimensions.find((d) => d.key === "safety")!;
    expect(safety.earned).toBeLessThan(safety.maxEarnable);
  });

  it("applies a hint penalty to the total", () => {
    const withoutHints = scoreCaseAttempt(baseInput({ diagnosis: "St elevation myocardial infarction" }));
    const withHints = scoreCaseAttempt(baseInput({ diagnosis: "St elevation myocardial infarction", hintsUsed: 3 }));
    expect(withHints.total).toBeLessThan(withoutHints.total);
    expect(withHints.hintPenalty).toBeGreaterThan(0);
  });

  it("never returns a total below zero even with many penalties", () => {
    const result = scoreCaseAttempt(baseInput({ hintsUsed: 50 }));
    expect(result.total).toBeGreaterThanOrEqual(0);
  });
});
