/**
 * Case data model. This is the schema the case engine (src/lib/caseEngine)
 * operates on. Server-only fields (referenceDiagnosis-adjacent facts,
 * rubric weights, critical/unsafe action lists, viva answer keys) live here
 * but are stripped by caseEngine/publicView.ts before anything is sent to
 * the browser pre-submission — see docs/STUDENT_PLATFORM_ARCHITECTURE.md §2.6.
 */

export type CaseStage =
  | "TRIAGE"
  | "HISTORY"
  | "PHYSICAL"
  | "DIFFERENTIAL"
  | "INVESTIGATIONS"
  | "INTERPRETATION"
  | "DIAGNOSIS"
  | "MANAGEMENT"
  | "PRESCRIPTION"
  | "MONITORING"
  | "DISPOSITION"
  | "DOCUMENTATION"
  | "VIVA"
  | "DEBRIEF"
  | "COMPLETE";

export const CASE_STAGE_ORDER: CaseStage[] = [
  "TRIAGE",
  "HISTORY",
  "PHYSICAL",
  "DIFFERENTIAL",
  "INVESTIGATIONS",
  "INTERPRETATION",
  "DIAGNOSIS",
  "MANAGEMENT",
  "PRESCRIPTION",
  "MONITORING",
  "DISPOSITION",
  "DOCUMENTATION",
  "VIVA",
  "DEBRIEF",
  "COMPLETE",
];

export type LearningTrack = "MEDICINE" | "NURSING" | "PHARMACY" | "DIAGNOSTICS" | "PHYSIOTHERAPY" | "PUBLIC_HEALTH";

export type Difficulty = "FOUNDATION" | "INTERMEDIATE" | "ADVANCED" | "RESIDENT_LEVEL" | "EXPERT";
export type Acuity = "ROUTINE" | "URGENT" | "EMERGENCY";
export type CaseSourceType = "SYNTHETIC" | "DEIDENTIFIED_CLINICAL" | "HISTORICAL_TEACHING" | "INSTITUTION_AUTHORED";

export interface VitalSnapshot {
  hr: number;
  sbp: number;
  dbp: number;
  rr: number;
  spo2: number;
  tempC: number;
  gcs: number;
  status: "stable" | "concern" | "critical";
  label?: string; // e.g. "On arrival", "T+10 min"
}

export interface HistoryNode {
  id: string;
  question: string;
  category:
    | "presenting-complaint"
    | "associated-symptoms"
    | "past-medical"
    | "medications"
    | "allergies"
    | "family"
    | "social"
    | "obstetric"
    | "review-of-systems";
  answer: string;
  /** Marks a fact that should change the student's differential if elicited. */
  isKeyFinding?: boolean;
  /** id's of other HistoryNodes that must be asked first for this one to make sense in a transcript (purely UX ordering, not enforced). */
  followsFrom?: string[];
}

export interface ExamFinding {
  id: string;
  system:
    | "general"
    | "vitals"
    | "cardiovascular"
    | "respiratory"
    | "abdominal"
    | "neurological"
    | "musculoskeletal"
    | "skin"
    | "ent"
    | "ophthalmic"
    | "obstetric"
    | "pediatric"
    | "mental-status";
  finding: string;
  isKeyFinding?: boolean;
}

export type InvestigationCategory =
  | "hematology"
  | "biochemistry"
  | "microbiology"
  | "serology"
  | "urinalysis"
  | "abg-vbg"
  | "ecg"
  | "xray"
  | "ultrasound"
  | "ct"
  | "mri"
  | "echo"
  | "doppler"
  | "endoscopy"
  | "pathology"
  | "cultures"
  | "special";

export interface InvestigationOption {
  id: string;
  name: string;
  category: InvestigationCategory;
  indication: string;
  turnaroundMinutes: number;
  resultSummary: string;
  interpretation: string;
  isDiagnostic?: boolean;
  isDistractor?: boolean;
}

export interface ManagementStep {
  id: string;
  label: string;
  description: string;
  isCritical?: boolean;
  isUnsafeIfChosen?: boolean;
}

export interface PrescriptionReferenceDrug {
  genericName: string;
  formulation: string;
  strength: string;
  route: string;
  frequency: string;
  duration: string;
  indication: string;
  monitoring?: string;
}

export interface PrescriptionContext {
  ageYears?: number;
  weightKg?: number;
  allergies: string[];
  pregnancyStatus?: "not-applicable" | "not-pregnant" | "pregnant" | "unknown";
  renalFunction: "normal" | "impaired" | "failure";
  hepaticFunction: "normal" | "impaired" | "failure";
  currentMedications: string[];
  diagnoses: string[];
}

export interface ScoringRubricDimension {
  key:
    | "history"
    | "examination"
    | "differential"
    | "investigations"
    | "diagnosis"
    | "management"
    | "prescription"
    | "safety"
    | "documentation";
  label: string;
  weight: number; // points out of 100 across all dimensions
}

export interface ScoringRubric {
  dimensions: ScoringRubricDimension[];
  passScore: number;
}

export interface VivaQuestion {
  id: string;
  stage: "case" | "rapid-fire" | "grand" | "drug" | "ecg" | "pathology" | "emergency";
  prompt: string;
  idealAnswerPoints: string[];
  followUp?: string;
}

export interface CaseContent {
  presentation: string;
  initialVitals: VitalSnapshot;
  vitalsTimeline?: VitalSnapshot[]; // deterministic deterioration/response sequence
  historyTree: HistoryNode[];
  examFindings: ExamFinding[];
  investigations: InvestigationOption[];
  redFlags: string[];
  referenceDifferentials: { diagnosis: string; rationale: string; mustNotMiss?: boolean }[];
  managementPathway: ManagementStep[];
  criticalActions: string[];
  unsafeActions: string[];
  prescriptionContext: PrescriptionContext;
  prescriptionReference: PrescriptionReferenceDrug[];
  debrief: { pearls: string[]; references: string[] };
}

export interface ClinicalCaseSummary {
  id: string;
  slug: string;
  title: string;
  specialty: string;
  subspecialty?: string | null;
  difficulty: Difficulty;
  acuity: Acuity;
  sourceType: CaseSourceType;
  learnerTracks: LearningTrack[];
  patientName: string;
  patientAgeBand: string;
  patientSex: string;
  chiefComplaint: string;
  isPublished: boolean;
}

export interface ClinicalCaseFull extends ClinicalCaseSummary {
  learningObjectives: string[];
  content: CaseContent;
  referenceDx: string;
  rubric: ScoringRubric;
  viva: VivaQuestion[];
}

/** What the client is allowed to see for an in-progress (unsubmitted) attempt. */
export interface CasePublicView extends ClinicalCaseSummary {
  learningObjectives: string[];
  presentation: string;
  currentVitals: VitalSnapshot;
  /** Every askable question (id + prompt only — never the answer) so the student can choose what to ask. */
  availableHistoryQuestions: Pick<HistoryNode, "id" | "question" | "category">[];
  revealedHistory: HistoryNode[];
  unaskedHistoryCategories: string[];
  availableExamSystems: ExamFinding["system"][];
  revealedExamFindings: ExamFinding[];
  availableInvestigationCatalog: Pick<InvestigationOption, "id" | "name" | "category" | "indication" | "turnaroundMinutes">[];
  orderedInvestigationResults: InvestigationOption[];
  /** Selectable management actions (id + label/description only — critical/unsafe flags are the answer key). */
  managementOptions: Pick<ManagementStep, "id" | "label" | "description">[];
  prescriptionContext: PrescriptionContext;
  stage: CaseStage;
  hintsUsed: number;
}
