import type { AIProvider, CaseFactSheet } from "./provider";

/**
 * Deterministic, scripted fallback used whenever ANTHROPIC_API_KEY is absent
 * or AI_PROVIDER=mock. No page should ever hard-fail because AI is
 * unavailable — this keeps the structured case engine fully usable, per
 * brief §49.
 */
export class MockAIProvider implements AIProvider {
  readonly id = "mock" as const;

  async patientDialogue(fact: CaseFactSheet, studentQuestion: string): Promise<string> {
    const q = studentQuestion.toLowerCase();
    if (q.includes("pain") && fact.chiefComplaint.toLowerCase().includes("pain")) {
      return "It's still there, pretty much the same as when it started.";
    }
    if (q.includes("when") || q.includes("start")) {
      return `It started around when I mentioned — ${fact.chiefComplaint.toLowerCase()}.`;
    }
    return "I'm not sure, doctor — that wasn't something anyone's asked me about yet.";
  }

  async vivaExaminer(input: Parameters<AIProvider["vivaExaminer"]>[0]): Promise<string> {
    const bank = [
      "What is your provisional diagnosis, and what single finding most strongly supports it?",
      "What dangerous alternative diagnosis must you exclude here, and why?",
      "Which investigation would most change your management right now?",
      "What would make you escalate this patient's care immediately?",
      "Talk me through your monitoring plan for the next 24 hours.",
    ];
    return bank[input.priorQuestions.length % bank.length];
  }

  async tutorFeedback(input: Parameters<AIProvider["tutorFeedback"]>[0]): Promise<string> {
    if (input.mode === "DEBRIEF") {
      return "Structured debrief (AI Tutor unavailable — using rule-based summary): review the reference differential and management pathway shown below, paying particular attention to any missed critical actions.";
    }
    if (input.weakDimension) {
      return `Focus your revision on ${input.weakDimension.toLowerCase()} — that's the biggest gap between your answer and the reference pathway.`;
    }
    return "AI Tutor unavailable — structured case mode remains available. Review the debrief panel for the reference reasoning.";
  }
}
