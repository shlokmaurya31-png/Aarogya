import { describe, it, expect } from "vitest";
import { MockAIProvider } from "./mockProvider";
import type { CaseFactSheet } from "./provider";

const FACT: CaseFactSheet = {
  caseTitle: "Test case",
  chiefComplaint: "chest pain",
  presentation: "A patient presents with chest pain.",
  knownHistory: [],
  knownExamFindings: [],
  knownInvestigationResults: [],
};

describe("MockAIProvider", () => {
  const provider = new MockAIProvider();

  it("declines to answer questions about facts not in the fact sheet", async () => {
    const answer = await provider.patientDialogue(FACT, "What was your troponin level?");
    expect(answer.toLowerCase()).toMatch(/not sure|don't know|wasn't/i);
  });

  it("never fails without an API key — id is 'mock'", () => {
    expect(provider.id).toBe("mock");
  });

  it("viva examiner cycles through a fixed question bank deterministically", async () => {
    const q1 = await provider.vivaExaminer({ stage: "case", caseTitle: "x", priorQuestions: [], performanceHint: "average" });
    const q2 = await provider.vivaExaminer({ stage: "case", caseTitle: "x", priorQuestions: [{ prompt: q1, studentAnswer: "a" }], performanceHint: "average" });
    expect(q1).not.toBe(q2);
  });

  it("tutor feedback in DEBRIEF mode never claims to be a live AI response", async () => {
    const feedback = await provider.tutorFeedback({ mode: "DEBRIEF", caseTitle: "x", scoreSummary: "70/100" });
    expect(feedback).toContain("AI Tutor unavailable");
  });
});
