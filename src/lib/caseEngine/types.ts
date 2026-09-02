import type { CaseStage } from "@/types/clinicalCase";

export interface RevealedState {
  revealedHistoryIds: string[];
  revealedExamIds: string[];
  orderedInvestigationIds: string[];
  vitalsIndex: number;
}

export function emptyRevealedState(): RevealedState {
  return { revealedHistoryIds: [], revealedExamIds: [], orderedInvestigationIds: [], vitalsIndex: 0 };
}

export interface DifferentialEntry {
  diagnosis: string;
  probability: number;
  supportingEvidence: string;
  contradictingEvidence?: string;
  mustNotMiss?: boolean;
}

export type CaseActionInput =
  | { type: "ask-history"; historyNodeId: string }
  | { type: "select-exam"; system: string }
  | { type: "order-investigation"; investigationId: string }
  | { type: "submit-differential"; entries: DifferentialEntry[] }
  | { type: "submit-diagnosis"; diagnosis: string }
  | { type: "submit-management"; selectedStepIds: string[] }
  | { type: "submit-prescription"; drugs: PrescriptionEntry[] }
  | { type: "hint" }
  | { type: "advance-stage"; to: CaseStage }
  | { type: "submit-case" };

export interface PrescriptionEntry {
  drug: string;
  genericName: string;
  formulation: string;
  strength: string;
  dose: string;
  route: string;
  frequency: string;
  duration: string;
  indication: string;
  instructions?: string;
}
