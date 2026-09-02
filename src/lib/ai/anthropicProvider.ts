import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider, CaseFactSheet } from "./provider";
import { buildPatientDialoguePrompt, buildVivaExaminerPrompt, buildTutorPrompt } from "./prompts";

const MODEL = "claude-sonnet-5";

export class AnthropicAIProvider implements AIProvider {
  readonly id = "anthropic" as const;
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  private async complete(system: string, userMessage: string, maxTokens = 300): Promise<string> {
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userMessage }],
    });
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }

  async patientDialogue(fact: CaseFactSheet, studentQuestion: string): Promise<string> {
    return this.complete(buildPatientDialoguePrompt(fact), studentQuestion, 220);
  }

  async vivaExaminer(input: {
    stage: string;
    caseTitle: string;
    priorQuestions: { prompt: string; studentAnswer: string }[];
    performanceHint: "strong" | "average" | "struggling";
  }): Promise<string> {
    const transcript = input.priorQuestions.length
      ? input.priorQuestions.map((p) => `Examiner: ${p.prompt}\nStudent: ${p.studentAnswer}`).join("\n\n")
      : "(viva just starting)";
    const userMessage = `Case: ${input.caseTitle}\nViva stage: ${input.stage}\nStudent performance so far: ${input.performanceHint}\n\nTranscript:\n${transcript}\n\nAsk the next viva question.`;
    return this.complete(buildVivaExaminerPrompt(), userMessage, 150);
  }

  async tutorFeedback(input: { mode: "TEACH" | "HINT" | "SOCRATIC" | "EXAM" | "DEBRIEF"; caseTitle: string; scoreSummary: string; weakDimension?: string }): Promise<string> {
    const userMessage = `Case: ${input.caseTitle}\nScore summary: ${input.scoreSummary}${
      input.weakDimension ? `\nWeakest dimension: ${input.weakDimension}` : ""
    }\n\nProvide feedback in ${input.mode} mode.`;
    return this.complete(buildTutorPrompt(input.mode), userMessage, input.mode === "DEBRIEF" ? 500 : 200);
  }
}
