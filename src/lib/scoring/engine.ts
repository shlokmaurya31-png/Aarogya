/**
 * CaseScoringEngine — deterministic, rubric-driven. An LLM never sets this
 * number; the AI layer (src/lib/ai/provider.ts) only adds qualitative
 * narrative feedback on top of a score that already exists here. See
 * docs/STUDENT_PLATFORM_ARCHITECTURE.md §2.6.
 */
import type { CaseContent, ScoringRubric } from "@/types/clinicalCase";
import type { RevealedState, DifferentialEntry, PrescriptionEntry } from "@/lib/caseEngine/types";
import { diagnosisMatches } from "./normalize";
import { validatePrescription } from "@/lib/rxlab/validate";

export interface DimensionScore {
  key: string;
  label: string;
  weight: number;
  earned: number;
  maxEarnable: number;
  notes: string[];
}

export interface CaseScoreBreakdown {
  dimensions: DimensionScore[];
  total: number;
  maxTotal: number;
  passScore: number;
  passed: boolean;
  missedCriticalActions: string[];
  unsafeActionsChosen: string[];
  hintsUsed: number;
  hintPenalty: number;
}

export interface ScoringInputs {
  content: CaseContent;
  rubric: ScoringRubric;
  referenceDx: string;
  revealed: RevealedState;
  differential: DifferentialEntry[] | null;
  diagnosis: string | null;
  managementSelectedStepIds: string[] | null;
  prescriptions: PrescriptionEntry[] | null;
  hintsUsed: number;
}

function dim(rubric: ScoringRubric, key: ScoringRubric["dimensions"][number]["key"]) {
  return rubric.dimensions.find((d) => d.key === key);
}

export function scoreCaseAttempt(input: ScoringInputs): CaseScoreBreakdown {
  const { content, rubric, referenceDx, revealed, differential, diagnosis, managementSelectedStepIds, prescriptions, hintsUsed } = input;
  const dimensions: DimensionScore[] = [];

  // History
  const historyDim = dim(rubric, "history");
  if (historyDim) {
    const keyNodes = content.historyTree.filter((n) => n.isKeyFinding);
    const revealedKey = keyNodes.filter((n) => revealed.revealedHistoryIds.includes(n.id));
    const ratio = keyNodes.length ? revealedKey.length / keyNodes.length : 1;
    dimensions.push({
      key: "history", label: historyDim.label, weight: historyDim.weight,
      earned: Math.round(ratio * historyDim.weight * 10) / 10, maxEarnable: historyDim.weight,
      notes: [`Elicited ${revealedKey.length}/${keyNodes.length} key history findings.`],
    });
  }

  // Examination
  const examDim = dim(rubric, "examination");
  if (examDim) {
    const keyFindings = content.examFindings.filter((f) => f.isKeyFinding);
    const revealedKey = keyFindings.filter((f) => revealed.revealedExamIds.includes(f.id));
    const ratio = keyFindings.length ? revealedKey.length / keyFindings.length : 1;
    dimensions.push({
      key: "examination", label: examDim.label, weight: examDim.weight,
      earned: Math.round(ratio * examDim.weight * 10) / 10, maxEarnable: examDim.weight,
      notes: [`Found ${revealedKey.length}/${keyFindings.length} key exam findings.`],
    });
  }

  // Differential
  const diffDim = dim(rubric, "differential");
  if (diffDim) {
    const refs = content.referenceDifferentials;
    let matched = 0;
    let mustNotMissMatched = 0;
    const mustNotMissTotal = refs.filter((r) => r.mustNotMiss).length;
    const submitted = differential ?? [];
    for (const ref of refs) {
      const hit = submitted.some((s) => diagnosisMatches(s.diagnosis, ref.diagnosis));
      if (hit) {
        matched += 1;
        if (ref.mustNotMiss) mustNotMissMatched += 1;
      }
    }
    const breadthRatio = refs.length ? matched / refs.length : submitted.length > 0 ? 1 : 0;
    const safetyRatio = mustNotMissTotal ? mustNotMissMatched / mustNotMissTotal : 1;
    const ratio = 0.6 * breadthRatio + 0.4 * safetyRatio;
    dimensions.push({
      key: "differential", label: diffDim.label, weight: diffDim.weight,
      earned: Math.round(ratio * diffDim.weight * 10) / 10, maxEarnable: diffDim.weight,
      notes: [
        `Matched ${matched}/${refs.length} reference differentials.`,
        mustNotMissTotal ? `Identified ${mustNotMissMatched}/${mustNotMissTotal} must-not-miss diagnoses.` : "No must-not-miss diagnoses in this case.",
      ],
    });
  }

  // Investigations
  const invDim = dim(rubric, "investigations");
  if (invDim) {
    const diagnostic = content.investigations.filter((i) => i.isDiagnostic);
    const ordered = content.investigations.filter((i) => revealed.orderedInvestigationIds.includes(i.id));
    const orderedDiagnostic = ordered.filter((i) => i.isDiagnostic).length;
    const orderedDistractor = ordered.filter((i) => i.isDistractor).length;
    const ratio = diagnostic.length ? orderedDiagnostic / diagnostic.length : 1;
    const distractorPenalty = Math.min(orderedDistractor * 0.1, 0.4);
    const finalRatio = Math.max(ratio - distractorPenalty, 0);
    dimensions.push({
      key: "investigations", label: invDim.label, weight: invDim.weight,
      earned: Math.round(finalRatio * invDim.weight * 10) / 10, maxEarnable: invDim.weight,
      notes: [
        `Ordered ${orderedDiagnostic}/${diagnostic.length} indicated investigations.`,
        orderedDistractor ? `Ordered ${orderedDistractor} low-yield/distractor investigation(s).` : "No unnecessary investigations ordered.",
      ],
    });
  }

  // Diagnosis
  const dxDim = dim(rubric, "diagnosis");
  if (dxDim) {
    const hit = diagnosis ? diagnosisMatches(diagnosis, referenceDx, 0.55) : false;
    dimensions.push({
      key: "diagnosis", label: dxDim.label, weight: dxDim.weight,
      earned: hit ? dxDim.weight : 0, maxEarnable: dxDim.weight,
      notes: [hit ? "Final diagnosis matches the reference diagnosis." : "Final diagnosis does not match the reference diagnosis."],
    });
  }

  // Management
  const mgmtDim = dim(rubric, "management");
  let unsafeChosenLabels: string[] = [];
  let missedCriticalLabels: string[] = [];
  if (mgmtDim) {
    const selected = managementSelectedStepIds ?? [];
    const criticalSteps = content.managementPathway.filter((s) => s.isCritical);
    const unsafeSteps = content.managementPathway.filter((s) => s.isUnsafeIfChosen);
    const criticalHit = criticalSteps.filter((s) => selected.includes(s.id));
    const unsafeHit = unsafeSteps.filter((s) => selected.includes(s.id));
    missedCriticalLabels = criticalSteps.filter((s) => !selected.includes(s.id)).map((s) => s.label);
    unsafeChosenLabels = unsafeHit.map((s) => s.label);
    const ratio = criticalSteps.length ? criticalHit.length / criticalSteps.length : 1;
    const penalty = Math.min(unsafeHit.length * 0.25, 1);
    const finalRatio = Math.max(ratio - penalty, 0);
    dimensions.push({
      key: "management", label: mgmtDim.label, weight: mgmtDim.weight,
      earned: Math.round(finalRatio * mgmtDim.weight * 10) / 10, maxEarnable: mgmtDim.weight,
      notes: [
        `Took ${criticalHit.length}/${criticalSteps.length} critical management actions.`,
        unsafeHit.length ? `Chose ${unsafeHit.length} unsafe action(s).` : "No unsafe management actions chosen.",
      ],
    });
  }

  // Prescription
  const rxDim = dim(rubric, "prescription");
  if (rxDim) {
    const drugs = prescriptions ?? [];
    const warnings = drugs.length ? validatePrescription(drugs, content.prescriptionContext) : [];
    const dangerCount = warnings.filter((w) => w.severity === "danger").length;
    const warnCount = warnings.filter((w) => w.severity === "warning").length;
    const referenceGenerics = content.prescriptionReference.map((r) => r.genericName.toLowerCase());
    const matchedRef = drugs.filter((d) => referenceGenerics.some((g) => d.genericName.toLowerCase().includes(g) || g.includes(d.genericName.toLowerCase())));
    const coverageRatio = referenceGenerics.length ? Math.min(matchedRef.length / referenceGenerics.length, 1) : drugs.length > 0 ? 1 : 0;
    const penalty = Math.min(dangerCount * 0.35 + warnCount * 0.12, 1);
    const finalRatio = Math.max(coverageRatio - penalty, 0);
    dimensions.push({
      key: "prescription", label: rxDim.label, weight: rxDim.weight,
      earned: Math.round(finalRatio * rxDim.weight * 10) / 10, maxEarnable: rxDim.weight,
      notes: [
        `Prescribed ${matchedRef.length}/${referenceGenerics.length} reference-appropriate medications.`,
        warnings.length ? `${dangerCount} dangerous + ${warnCount} warning-level prescribing issue(s).` : "No prescribing safety issues flagged.",
      ],
    });
  }

  // Safety (composite: unsafe management + dangerous prescriptions)
  const safetyDim = dim(rubric, "safety");
  if (safetyDim) {
    const drugs = prescriptions ?? [];
    const warnings = drugs.length ? validatePrescription(drugs, content.prescriptionContext) : [];
    const dangerCount = warnings.filter((w) => w.severity === "danger").length;
    const unsafeCount = unsafeChosenLabels.length;
    const incidents = dangerCount + unsafeCount;
    const ratio = incidents === 0 ? 1 : Math.max(1 - incidents * 0.3, 0);
    dimensions.push({
      key: "safety", label: safetyDim.label, weight: safetyDim.weight,
      earned: Math.round(ratio * safetyDim.weight * 10) / 10, maxEarnable: safetyDim.weight,
      notes: [incidents === 0 ? "No patient-safety incidents recorded." : `${incidents} patient-safety incident(s) recorded.`],
    });
  }

  // Documentation (lightweight in this pass — full note-grading is a follow-up, see architecture doc §4)
  const docDim = dim(rubric, "documentation");
  if (docDim) {
    const hasDiagnosis = Boolean(diagnosis);
    const hasManagement = Boolean(managementSelectedStepIds?.length);
    const ratio = (Number(hasDiagnosis) + Number(hasManagement)) / 2;
    dimensions.push({
      key: "documentation", label: docDim.label, weight: docDim.weight,
      earned: Math.round(ratio * docDim.weight * 10) / 10, maxEarnable: docDim.weight,
      notes: ["Documentation completeness inferred from diagnosis + management being recorded."],
    });
  }

  const rawTotal = dimensions.reduce((sum, d) => sum + d.earned, 0);
  const maxTotal = dimensions.reduce((sum, d) => sum + d.maxEarnable, 0);
  const hintPenalty = Math.min(hintsUsed * 2, 15);
  const total = Math.max(Math.round((rawTotal - hintPenalty) * 10) / 10, 0);

  return {
    dimensions,
    total,
    maxTotal,
    passScore: rubric.passScore,
    passed: total >= rubric.passScore,
    missedCriticalActions: missedCriticalLabels,
    unsafeActionsChosen: unsafeChosenLabels,
    hintsUsed,
    hintPenalty,
  };
}
