import type { ScoringRubric } from "@/types/clinicalCase";

export const DEFAULT_RUBRIC: ScoringRubric = {
  dimensions: [
    { key: "history", label: "History Quality", weight: 15 },
    { key: "examination", label: "Physical Examination", weight: 10 },
    { key: "differential", label: "Differential Diagnosis", weight: 15 },
    { key: "investigations", label: "Investigation Strategy", weight: 10 },
    { key: "diagnosis", label: "Diagnostic Accuracy", weight: 15 },
    { key: "management", label: "Management", weight: 15 },
    { key: "prescription", label: "Prescription", weight: 10 },
    { key: "safety", label: "Patient Safety", weight: 5 },
    { key: "documentation", label: "Documentation", weight: 3 },
  ],
  passScore: 60,
};

export const EMERGENCY_RUBRIC: ScoringRubric = {
  dimensions: [
    { key: "history", label: "History Quality", weight: 10 },
    { key: "examination", label: "Physical Examination", weight: 10 },
    { key: "differential", label: "Differential Diagnosis", weight: 10 },
    { key: "investigations", label: "Investigation Strategy", weight: 10 },
    { key: "diagnosis", label: "Diagnostic Accuracy", weight: 15 },
    { key: "management", label: "Management", weight: 20 },
    { key: "prescription", label: "Prescription", weight: 5 },
    { key: "safety", label: "Patient Safety", weight: 17 },
    { key: "documentation", label: "Documentation", weight: 3 },
  ],
  passScore: 65,
};
