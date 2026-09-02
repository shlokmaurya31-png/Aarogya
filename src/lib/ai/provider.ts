/**
 * Server-side AI service boundary for Aarogya Scholar. React components
 * never import @anthropic-ai/sdk or call Anthropic directly — they call
 * /api/student/* routes, which call getAIProvider() here. This also means
 * the whole app works with no API key: getAIProvider() returns
 * MockAIProvider whenever ANTHROPIC_API_KEY is unset, so no Scholar page
 * hard-fails without one (brief §49).
 */

export interface CaseFactSheet {
  caseTitle: string;
  chiefComplaint: string;
  presentation: string;
  knownHistory: { question: string; answer: string }[];
  knownExamFindings: string[];
  knownInvestigationResults: string[];
}

export interface AIProvider {
  readonly id: "anthropic" | "mock";
  /** Simulated patient answering an ad-hoc free-text question, constrained to CaseFactSheet only. */
  patientDialogue(fact: CaseFactSheet, studentQuestion: string): Promise<string>;
  /** One viva question at a time, adapting to a short performance summary. */
  vivaExaminer(input: {
    stage: string;
    caseTitle: string;
    priorQuestions: { prompt: string; studentAnswer: string }[];
    performanceHint: "strong" | "average" | "struggling";
  }): Promise<string>;
  /** Qualitative feedback layered on top of an already-computed deterministic score. */
  tutorFeedback(input: {
    mode: "TEACH" | "HINT" | "SOCRATIC" | "EXAM" | "DEBRIEF";
    caseTitle: string;
    scoreSummary: string;
    weakDimension?: string;
  }): Promise<string>;
}

export class AIUnavailableError extends Error {}
