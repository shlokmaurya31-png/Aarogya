import type { LabReportCategory } from "@/types";

export interface LabCategoryDef {
  id: LabReportCategory;
  label: string;
  examples: string[];
}

export const LAB_REPORT_CATEGORIES: LabCategoryDef[] = [
  {
    id: "routine-blood-panel",
    label: "Routine Blood Panels",
    examples: ["Complete Blood Count (CBC)", "Basic Metabolic Panel (BMP)", "Comprehensive Metabolic Panel (CMP)"],
  },
  {
    id: "lipid-panel",
    label: "Lipid Panel",
    examples: ["Total Cholesterol", "HDL", "LDL", "Triglycerides"],
  },
  {
    id: "thyroid-panel",
    label: "Thyroid Panel",
    examples: ["TSH", "Free T3", "Free T4"],
  },
  {
    id: "diabetes-profile",
    label: "Diabetes Profile",
    examples: ["Fasting Glucose", "Post-Prandial Glucose", "HbA1c"],
  },
  {
    id: "liver-function-test",
    label: "Liver Function Test (LFT)",
    examples: ["SGOT / SGPT", "Bilirubin", "Alkaline Phosphatase", "Albumin"],
  },
  {
    id: "kidney-function-test",
    label: "Kidney Function Test (KFT)",
    examples: ["Creatinine", "Urea", "Uric Acid", "eGFR"],
  },
  {
    id: "cardiac-risk-markers",
    label: "Cardiac Risk Markers",
    examples: ["Troponin", "CK-MB", "Cardiac Risk Ratio"],
  },
  {
    id: "vitamin-panel",
    label: "Vitamin Panel",
    examples: ["Vitamin D (25-OH)", "Vitamin B12", "Folate"],
  },
  {
    id: "hormone-panel",
    label: "Hormone Panel",
    examples: ["Testosterone", "Estrogen", "Cortisol", "Prolactin"],
  },
  {
    id: "iron-studies",
    label: "Iron Studies",
    examples: ["Serum Iron", "Ferritin", "TIBC", "Transferrin Saturation"],
  },
  {
    id: "urinalysis",
    label: "Urinalysis",
    examples: ["Gross visual examination", "Chemical dipstick testing", "Microscopic sediment analysis"],
  },
  {
    id: "biopsy-pathology",
    label: "Biopsy & Pathology",
    examples: ["Histopathology (tissue slices)", "Cytopathology (individual cells)", "Surgical pathology"],
  },
  {
    id: "microbiology-culture",
    label: "Microbiology Cultures",
    examples: ["Blood culture", "Wound culture", "Throat culture", "Sputum culture"],
  },
  {
    id: "infectious-disease-serology",
    label: "Infectious Disease Serology",
    examples: ["HIV", "Hepatitis", "Lyme disease", "Viral infections"],
  },
  {
    id: "molecular-pcr",
    label: "Molecular Diagnostics & PCR",
    examples: ["COVID-19", "Influenza", "Hereditary gene mutations"],
  },
  {
    id: "toxicology-drug-screen",
    label: "Toxicology & Drug Screens",
    examples: ["Blood screen", "Urine screen", "Hair screen"],
  },
  {
    id: "coagulation-panel",
    label: "Coagulation Panel",
    examples: ["Prothrombin Time (PT)", "INR", "Partial Thromboplastin Time (PTT)"],
  },
  {
    id: "immunology-autoimmune",
    label: "Immunology & Autoimmune",
    examples: ["Rheumatoid Factor (RF)", "Antinuclear Antibody (ANA)", "Allergy IgE testing"],
  },
];

export const LAB_CATEGORY_MAP: Record<LabReportCategory, LabCategoryDef> = Object.fromEntries(
  LAB_REPORT_CATEGORIES.map((c) => [c.id, c])
) as Record<LabReportCategory, LabCategoryDef>;
