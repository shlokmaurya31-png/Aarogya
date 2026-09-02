/**
 * Strips a ClinicalCaseFull (which includes the answer key) down to what an
 * in-progress attempt is allowed to see. This is the boundary called out in
 * the brief §25 "anti-cheating case state" — the reference diagnosis,
 * rubric, critical/unsafe action lists, and viva answers never appear in
 * this function's return value.
 */
import type { ClinicalCaseFull, CasePublicView, HistoryNode } from "@/types/clinicalCase";
import type { RevealedState } from "./types";

const HISTORY_CATEGORIES = [
  "presenting-complaint",
  "associated-symptoms",
  "past-medical",
  "medications",
  "allergies",
  "family",
  "social",
  "obstetric",
  "review-of-systems",
] as const;

export function toPublicView(
  full: ClinicalCaseFull,
  revealed: RevealedState,
  stage: CasePublicView["stage"],
  hintsUsed: number
): CasePublicView {
  const revealedHistory: HistoryNode[] = full.content.historyTree.filter((n) =>
    revealed.revealedHistoryIds.includes(n.id)
  );
  const askedCategories = new Set(revealedHistory.map((n) => n.category));
  const unaskedHistoryCategories = HISTORY_CATEGORIES.filter((c) => !askedCategories.has(c));

  const currentVitals =
    full.content.vitalsTimeline && full.content.vitalsTimeline.length > 0
      ? full.content.vitalsTimeline[Math.min(revealed.vitalsIndex, full.content.vitalsTimeline.length - 1)]
      : full.content.initialVitals;

  return {
    id: full.id,
    slug: full.slug,
    title: full.title,
    specialty: full.specialty,
    subspecialty: full.subspecialty,
    difficulty: full.difficulty,
    acuity: full.acuity,
    sourceType: full.sourceType,
    learnerTracks: full.learnerTracks,
    patientName: full.patientName,
    patientAgeBand: full.patientAgeBand,
    patientSex: full.patientSex,
    chiefComplaint: full.chiefComplaint,
    isPublished: full.isPublished,
    learningObjectives: full.learningObjectives,
    presentation: full.content.presentation,
    currentVitals,
    availableHistoryQuestions: full.content.historyTree.map((n) => ({ id: n.id, question: n.question, category: n.category })),
    revealedHistory,
    unaskedHistoryCategories,
    availableExamSystems: [...new Set(full.content.examFindings.map((f) => f.system))],
    revealedExamFindings: full.content.examFindings.filter((f) => revealed.revealedExamIds.includes(f.id)),
    availableInvestigationCatalog: full.content.investigations.map((i) => ({
      id: i.id,
      name: i.name,
      category: i.category,
      indication: i.indication,
      turnaroundMinutes: i.turnaroundMinutes,
    })),
    orderedInvestigationResults: full.content.investigations.filter((i) =>
      revealed.orderedInvestigationIds.includes(i.id)
    ),
    managementOptions: full.content.managementPathway.map((m) => ({ id: m.id, label: m.label, description: m.description })),
    prescriptionContext: full.content.prescriptionContext,
    stage,
    hintsUsed,
  };
}

/** Debrief view — only ever built AFTER attempt.submittedAt is set. Safe to include the answer key here. */
export function toDebriefView(full: ClinicalCaseFull) {
  return {
    referenceDx: full.referenceDx,
    referenceDifferentials: full.content.referenceDifferentials,
    criticalActions: full.content.criticalActions,
    unsafeActions: full.content.unsafeActions,
    managementPathway: full.content.managementPathway,
    prescriptionReference: full.content.prescriptionReference,
    debrief: full.content.debrief,
    redFlags: full.content.redFlags,
  };
}
