/**
 * RxLab educational prescription validation. These rules are deliberately
 * simple and explicitly scoped as educational — this is NOT a validated
 * clinical decision-support system, and every RxLab surface in the UI
 * carries the "EDUCATIONAL SIMULATION — NOT A VALID PRESCRIPTION" watermark.
 * See docs/STUDENT_PLATFORM_ARCHITECTURE.md §2.6.
 */
import type { PrescriptionContext } from "@/types/clinicalCase";
import type { PrescriptionEntry } from "@/lib/caseEngine/types";

export type RxWarningSeverity = "info" | "warning" | "danger";

export interface RxWarning {
  drugName: string;
  severity: RxWarningSeverity;
  code:
    | "allergy-conflict"
    | "duplicate-therapy"
    | "case-contraindication"
    | "renal-consideration"
    | "hepatic-consideration"
    | "pregnancy-consideration"
    | "route-error"
    | "duration-error"
    | "missing-monitoring";
  message: string;
}

const RENAL_CAUTION_DRUGS = ["metformin", "nsaid", "ibuprofen", "diclofenac", "gentamicin", "vancomycin", "enoxaparin"];
const HEPATIC_CAUTION_DRUGS = ["paracetamol", "acetaminophen", "statin", "atorvastatin", "isoniazid", "methotrexate"];
const PREGNANCY_CAUTION_DRUGS = ["warfarin", "ace inhibitor", "enalapril", "lisinopril", "statin", "atorvastatin", "methotrexate", "isotretinoin"];

function normalize(s: string) {
  return s.trim().toLowerCase();
}

export function validatePrescription(
  drugs: PrescriptionEntry[],
  context: PrescriptionContext
): RxWarning[] {
  const warnings: RxWarning[] = [];
  const seenGenerics = new Set<string>();

  for (const drug of drugs) {
    const generic = normalize(drug.genericName || drug.drug);

    // Allergy conflict — matched against the case's documented allergy list.
    for (const allergy of context.allergies) {
      if (generic.includes(normalize(allergy)) || normalize(allergy).includes(generic)) {
        warnings.push({
          drugName: drug.drug,
          severity: "danger",
          code: "allergy-conflict",
          message: `Case record lists an allergy to "${allergy}" — this conflicts with ${drug.drug}.`,
        });
      }
    }

    // Duplicate therapy — same generic prescribed twice in this attempt.
    if (seenGenerics.has(generic)) {
      warnings.push({
        drugName: drug.drug,
        severity: "warning",
        code: "duplicate-therapy",
        message: `${drug.drug} duplicates another drug already in this prescription (same generic).`,
      });
    }
    seenGenerics.add(generic);

    // Renal / hepatic considerations, driven by the case's documented function.
    if (context.renalFunction !== "normal" && RENAL_CAUTION_DRUGS.some((d) => generic.includes(d))) {
      warnings.push({
        drugName: drug.drug,
        severity: context.renalFunction === "failure" ? "danger" : "warning",
        code: "renal-consideration",
        message: `Case documents ${context.renalFunction} renal function — ${drug.drug} needs dose adjustment or monitoring.`,
      });
    }
    if (context.hepaticFunction !== "normal" && HEPATIC_CAUTION_DRUGS.some((d) => generic.includes(d))) {
      warnings.push({
        drugName: drug.drug,
        severity: context.hepaticFunction === "failure" ? "danger" : "warning",
        code: "hepatic-consideration",
        message: `Case documents ${context.hepaticFunction} hepatic function — ${drug.drug} needs dose adjustment or monitoring.`,
      });
    }

    // Pregnancy considerations.
    if (context.pregnancyStatus === "pregnant" && PREGNANCY_CAUTION_DRUGS.some((d) => generic.includes(d))) {
      warnings.push({
        drugName: drug.drug,
        severity: "danger",
        code: "pregnancy-consideration",
        message: `${drug.drug} is generally avoided in pregnancy — reconsider or document rationale.`,
      });
    }

    // Interaction with an existing medication documented in the case.
    for (const existing of context.currentMedications) {
      if (normalize(existing) === generic) {
        warnings.push({
          drugName: drug.drug,
          severity: "warning",
          code: "duplicate-therapy",
          message: `Patient is already documented as taking ${existing} — check for overlap with ${drug.drug}.`,
        });
      }
    }

    // Basic completeness / route-duration sanity.
    if (!drug.route.trim()) {
      warnings.push({ drugName: drug.drug, severity: "warning", code: "route-error", message: `${drug.drug} is missing a route of administration.` });
    }
    if (!drug.duration.trim()) {
      warnings.push({ drugName: drug.drug, severity: "info", code: "duration-error", message: `${drug.drug} has no duration specified.` });
    }
  }

  return warnings;
}
