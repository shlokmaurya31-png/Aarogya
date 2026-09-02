/**
 * Compact authoring format for synthetic teaching cases, expanded into the
 * full ClinicalCaseFull-shaped content the case engine expects. Keeping a
 * builder (rather than hand-writing 25 fully-expanded objects) is what makes
 * 25 *distinct* cases tractable to author and review in one pass while
 * guaranteeing every case has the same structural shape the engine relies on.
 *
 * Every case authored through this builder is SYNTHETIC / fictional — no
 * step here ever touches real clinical data (see src/lib/privacy/caseSanitizer.ts,
 * which every generated case is still run through as a policy check).
 */
import { generateEducationalIdentity, type EducationalSex } from "@/lib/privacy/educationalIdentity";
import { assertSyntheticCaseIsClean } from "@/lib/privacy/caseSanitizer";
import { DEFAULT_RUBRIC, EMERGENCY_RUBRIC } from "@/lib/scoring/defaultRubrics";
import type {
  CaseContent,
  Difficulty,
  Acuity,
  LearningTrack,
  VitalSnapshot,
  HistoryNode,
  ExamFinding,
  InvestigationOption,
  ManagementStep,
  VivaQuestion,
  ScoringRubric,
  PrescriptionContext,
  PrescriptionReferenceDrug,
} from "@/types/clinicalCase";

export { DEFAULT_RUBRIC, EMERGENCY_RUBRIC };

export interface HistoryDef {
  q: string;
  category: HistoryNode["category"];
  a: string;
  key?: boolean;
}
export interface ExamDef {
  system: ExamFinding["system"];
  finding: string;
  key?: boolean;
}
export interface InvestigationDef {
  name: string;
  category: InvestigationOption["category"];
  indication: string;
  turnaround: number;
  result: string;
  interpretation: string;
  diagnostic?: boolean;
  distractor?: boolean;
}
export interface ManagementDef {
  label: string;
  description: string;
  critical?: boolean;
  unsafe?: boolean;
}
export interface VivaDef {
  stage: VivaQuestion["stage"];
  prompt: string;
  points: string[];
  followUp?: string;
}

export interface CaseDef {
  slug: string;
  title: string;
  specialty: string;
  subspecialty?: string;
  difficulty: Difficulty;
  acuity: Acuity;
  learnerTracks: LearningTrack[];
  patientSex: EducationalSex;
  patientAgeBand: string;
  patientAgeExact?: number;
  chiefComplaint: string;
  learningObjectives: string[];
  presentation: string;
  initialVitals: VitalSnapshot;
  vitalsTimeline?: VitalSnapshot[];
  history: HistoryDef[];
  exam: ExamDef[];
  investigations: InvestigationDef[];
  redFlags: string[];
  referenceDifferentials: { diagnosis: string; rationale: string; mustNotMiss?: boolean }[];
  management: ManagementDef[];
  criticalActions: string[];
  unsafeActions: string[];
  prescriptionContext: PrescriptionContext;
  prescriptionReference: PrescriptionReferenceDrug[];
  referenceDx: string;
  viva: VivaDef[];
  debrief: { pearls: string[]; references: string[] };
  rubric?: ScoringRubric;
}

export interface BuiltCase {
  slug: string;
  title: string;
  specialty: string;
  subspecialty?: string;
  difficulty: Difficulty;
  acuity: Acuity;
  sourceType: "SYNTHETIC";
  learnerTracks: LearningTrack[];
  patientName: string;
  patientAgeBand: string;
  patientAgeExact?: number;
  patientSex: string;
  chiefComplaint: string;
  learningObjectives: string[];
  content: CaseContent;
  referenceDx: string;
  rubric: ScoringRubric;
  viva: VivaQuestion[];
}

function withIds<T>(prefix: string, items: T[]): (T & { id: string })[] {
  return items.map((item, i) => ({ ...item, id: `${prefix}-${i + 1}` }));
}

const SEX_LABEL: Record<EducationalSex, string> = {
  male: "Male",
  female: "Female",
  "intersex-unspecified": "Intersex (unspecified)",
};

export function buildCase(def: CaseDef): BuiltCase {
  const identity = generateEducationalIdentity(def.slug, def.patientSex);

  const historyTree: HistoryNode[] = withIds("h", def.history).map((h) => ({
    id: h.id,
    question: h.q,
    category: h.category,
    answer: h.a,
    isKeyFinding: h.key,
  }));

  const examFindings: ExamFinding[] = withIds("e", def.exam).map((e) => ({
    id: e.id,
    system: e.system,
    finding: e.finding,
    isKeyFinding: e.key,
  }));

  const investigations: InvestigationOption[] = withIds("i", def.investigations).map((i) => ({
    id: i.id,
    name: i.name,
    category: i.category,
    indication: i.indication,
    turnaroundMinutes: i.turnaround,
    resultSummary: i.result,
    interpretation: i.interpretation,
    isDiagnostic: i.diagnostic,
    isDistractor: i.distractor,
  }));

  const managementPathway: ManagementStep[] = withIds("m", def.management).map((m) => ({
    id: m.id,
    label: m.label,
    description: m.description,
    isCritical: m.critical,
    isUnsafeIfChosen: m.unsafe,
  }));

  const viva: VivaQuestion[] = withIds("v", def.viva).map((v) => ({
    id: v.id,
    stage: v.stage,
    prompt: v.prompt,
    idealAnswerPoints: v.points,
    followUp: v.followUp,
  }));

  const content: CaseContent = {
    presentation: def.presentation,
    initialVitals: def.initialVitals,
    vitalsTimeline: def.vitalsTimeline,
    historyTree,
    examFindings,
    investigations,
    redFlags: def.redFlags,
    referenceDifferentials: def.referenceDifferentials,
    managementPathway,
    criticalActions: def.criticalActions,
    unsafeActions: def.unsafeActions,
    prescriptionContext: def.prescriptionContext,
    prescriptionReference: def.prescriptionReference,
    debrief: def.debrief,
  };

  const built: BuiltCase = {
    slug: def.slug,
    title: def.title,
    specialty: def.specialty,
    subspecialty: def.subspecialty,
    difficulty: def.difficulty,
    acuity: def.acuity,
    sourceType: "SYNTHETIC",
    learnerTracks: def.learnerTracks,
    patientName: identity.name,
    patientAgeBand: def.patientAgeBand,
    patientAgeExact: def.patientAgeExact,
    patientSex: SEX_LABEL[def.patientSex],
    chiefComplaint: def.chiefComplaint,
    learningObjectives: def.learningObjectives,
    content,
    referenceDx: def.referenceDx,
    rubric: def.rubric ?? (def.acuity === "EMERGENCY" ? EMERGENCY_RUBRIC : DEFAULT_RUBRIC),
    viva,
  };

  assertSyntheticCaseIsClean(built);
  return built;
}
