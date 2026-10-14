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

/**
 * The portal assistant (/api/chat). `context` is the ONLY record the model
 * may use, already authorized and minimized server-side; it is never the
 * client's word. "patient": the signed-in patient (or a delegate) about their
 * own record. "clinician": hospital staff, optionally with one authorized
 * chart; Scholar users get no patient record at all.
 */
export interface AssistantInput {
  audience: "patient" | "clinician";
  context: string;
  /** The portal section the user is on, as a hint for open questions. */
  page?: string;
  message: string;
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
  /** One portal-assistant reply, grounded only in input.context. */
  assistantReply(input: AssistantInput): Promise<string>;
}

export class AIUnavailableError extends Error {}
