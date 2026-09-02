import { describe, it, expect } from "vitest";
import { applyAction, nextStage } from "./engine";
import { emptyRevealedState } from "./types";
import type { CaseContent } from "@/types/clinicalCase";

const CONTENT: CaseContent = {
  presentation: "Test presentation.",
  initialVitals: { hr: 80, sbp: 120, dbp: 80, rr: 16, spo2: 98, tempC: 37, gcs: 15, status: "stable" },
  historyTree: [
    { id: "h-1", question: "Where is the pain?", category: "presenting-complaint", answer: "Chest.", isKeyFinding: true },
    { id: "h-2", question: "Any fever?", category: "associated-symptoms", answer: "No." },
  ],
  examFindings: [
    { id: "e-1", system: "cardiovascular", finding: "Normal heart sounds.", isKeyFinding: true },
    { id: "e-2", system: "cardiovascular", finding: "No murmurs." },
    { id: "e-3", system: "respiratory", finding: "Clear lungs." },
  ],
  investigations: [
    { id: "i-1", name: "ECG", category: "ecg", indication: "Chest pain", turnaroundMinutes: 5, resultSummary: "Normal", interpretation: "No ischemia", isDiagnostic: true },
  ],
  redFlags: [],
  referenceDifferentials: [{ diagnosis: "Musculoskeletal chest pain", rationale: "Reproducible on palpation." }],
  managementPathway: [{ id: "m-1", label: "Reassure", description: "Reassure and discharge.", isCritical: true }],
  criticalActions: ["Reassure"],
  unsafeActions: [],
  prescriptionContext: { allergies: [], renalFunction: "normal", hepaticFunction: "normal", currentMedications: [], diagnoses: [] },
  prescriptionReference: [],
  debrief: { pearls: [], references: [] },
};

describe("applyAction", () => {
  it("reveals a history node and marks it in revealedHistoryIds", () => {
    const result = applyAction(CONTENT, emptyRevealedState(), "HISTORY", { type: "ask-history", historyNodeId: "h-1" });
    expect(result.revealed.revealedHistoryIds).toContain("h-1");
    expect(result.reveal).toEqual({ kind: "history", id: "h-1" });
  });

  it("returns an error for an unknown history node id", () => {
    const result = applyAction(CONTENT, emptyRevealedState(), "HISTORY", { type: "ask-history", historyNodeId: "does-not-exist" });
    expect(result.error).toBeDefined();
  });

  it("is idempotent — re-asking an already revealed question doesn't duplicate it", () => {
    const first = applyAction(CONTENT, emptyRevealedState(), "HISTORY", { type: "ask-history", historyNodeId: "h-1" });
    const second = applyAction(CONTENT, first.revealed, "HISTORY", { type: "ask-history", historyNodeId: "h-1" });
    expect(second.revealed.revealedHistoryIds.filter((id) => id === "h-1")).toHaveLength(1);
  });

  it("select-exam reveals every finding for that system at once", () => {
    const result = applyAction(CONTENT, emptyRevealedState(), "PHYSICAL", { type: "select-exam", system: "cardiovascular" });
    expect(result.revealed.revealedExamIds.sort()).toEqual(["e-1", "e-2"]);
    expect(result.reveal?.id).toEqual(expect.arrayContaining(["e-1", "e-2"]));
  });

  it("select-exam for a different system doesn't touch already-revealed findings", () => {
    const afterCardio = applyAction(CONTENT, emptyRevealedState(), "PHYSICAL", { type: "select-exam", system: "cardiovascular" });
    const afterResp = applyAction(CONTENT, afterCardio.revealed, "PHYSICAL", { type: "select-exam", system: "respiratory" });
    expect(afterResp.revealed.revealedExamIds.sort()).toEqual(["e-1", "e-2", "e-3"]);
  });

  it("order-investigation adds the investigation id", () => {
    const result = applyAction(CONTENT, emptyRevealedState(), "INVESTIGATIONS", { type: "order-investigation", investigationId: "i-1" });
    expect(result.revealed.orderedInvestigationIds).toContain("i-1");
  });

  it("submit-diagnosis advances the stage", () => {
    const result = applyAction(CONTENT, emptyRevealedState(), "DIAGNOSIS", { type: "submit-diagnosis", diagnosis: "Musculoskeletal chest pain" });
    expect(result.stage).toBe(nextStage("DIAGNOSIS"));
  });

  it("advance-stage moves directly to the requested stage", () => {
    const result = applyAction(CONTENT, emptyRevealedState(), "TRIAGE", { type: "advance-stage", to: "HISTORY" });
    expect(result.stage).toBe("HISTORY");
  });
});

describe("nextStage", () => {
  it("does not advance past COMPLETE", () => {
    expect(nextStage("COMPLETE")).toBe("COMPLETE");
  });
});
