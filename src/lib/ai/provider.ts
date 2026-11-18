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
 * The portal assistant (/api/chat), record-free since RAG Phase 1: it is
 * given NO patient record. A question about a record is answered by the
 * record gateway (src/lib/rag/ask.ts), with citations, or not at all. The
 * message arrives with identifiers masked (src/lib/rag/assistant.ts).
 */
export interface AssistantInput {
  audience: "patient" | "clinician";
  /** The portal section the user is on, as a hint for open questions. */
  page?: string;
  message: string;
}

declare const assistantPermitBrand: unique symbol;
/**
 * Issued only by the assistant gateway (src/lib/rag/assistant.ts) after its
 * checks. `real`: the caller's person or facility is REAL, so an external
 * provider also needs the switch and its own data-policy flag.
 */
export interface AssistantPermit { readonly real: boolean; readonly [assistantPermitBrand]: true }

/** What Aarogya Scholar may call: synthetic teaching cases only, never the portal assistant. */
export type ScholarAI = Pick<AIProvider, "id" | "patientDialogue" | "vivaExaminer" | "tutorFeedback">;

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
  /** One record-free portal-assistant reply. Needs a permit from the assistant gateway. */
  assistantReply(input: AssistantInput, permit: AssistantPermit): Promise<string>;
}

export class AIUnavailableError extends Error {}
