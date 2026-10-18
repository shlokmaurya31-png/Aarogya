import { Prisma, SafetySeverity } from "@prisma/client";
import { prisma } from "@/lib/db";
import { currentAllergyStatus } from "./clinicalRecords";

/**
 * Clinical decision support — deliberately narrow (brief §20/§101, and
 * Phase 3 §18's explicit "do not fabricate drug interaction knowledge").
 * Every rule here is checkable from data this prototype actually has —
 * documented allergies and this patient's own other active orders. A real
 * drug-interaction/renal-dosing/contraindication engine needs external
 * reference data this build doesn't include and doesn't pretend to
 * (docs/ENTERPRISE_HOSPITAL_ARCHITECTURE.md §8,
 * docs/PHASE_3_ARCHITECTURE.md §7). Every flag is transparent, traceable
 * to its source row, and a DANGER-severity flag requires an explicit
 * override reason to proceed — never a silent block, never a silent
 * allow.
 */
export interface SafetyFlag {
  rule: "allergy-conflict" | "allergy-info-withdrawn" | "allergy-status-unknown" | "duplicate-active-medication" | "route-mismatch" | "frequency-mismatch";
  severity: "warning" | "danger";
  message: string;
  sourceId: string;
}

export async function checkMedicationSafety(
  patientId: string,
  drugName: string,
  genericName?: string,
  route?: string,
  frequency?: string
): Promise<SafetyFlag[]> {
  const flags: SafetyFlag[] = [];
  const needle = (genericName || drugName).toLowerCase();

  // Week 4a: a patient-reported allergy counts while it is shared (ACTIVE); one the patient
  // withdrew is replaced by the content-free notice below.
  const allergies = await prisma.allergy.findMany({ where: { patientId, NOT: { source: "PATIENT_PROVIDED", status: { not: "ACTIVE" } } }, orderBy: [{ recordedAt: "asc" }, { id: "asc" }] });
  for (const allergy of allergies) {
    const substance = allergy.substance.toLowerCase();
    if (needle.includes(substance) || substance.includes(needle)) {
      const reported = allergy.source === "PATIENT_PROVIDED";
      flags.push({
        rule: "allergy-conflict",
        // An unknown severity is never assumed mild.
        severity: allergy.severity === "SEVERE" || allergy.severity === null ? "danger" : "warning",
        message: reported
          ? `Patient-reported allergy to "${allergy.substance}" (from an uploaded document, ${allergy.verification === "CONFIRMED" ? "confirmed" : "not yet confirmed by a clinician"}${allergy.severity ? `, ${allergy.severity}` : ", severity not recorded"})${allergy.reaction ? ` (reaction: ${allergy.reaction})` : ""}. Confirm with the patient.`
          : `Patient has a documented ${allergy.severity} allergy to "${allergy.substance}"${allergy.reaction ? ` (reaction: ${allergy.reaction})` : ""}.`,
        sourceId: allergy.id,
      });
    }
  }
  const withdrawn = await prisma.patientAllergyNotice.findFirst({ where: { patientId, kind: "WITHDRAWN_BY_PATIENT", resolvedAt: null }, select: { id: true } });
  if (withdrawn) {
    flags.push({ rule: "allergy-info-withdrawn", severity: "warning", message: "Allergy information withdrawn by the patient — ask about allergies.", sourceId: withdrawn.id });
  }
  // Week 4b: an UNKNOWN allergy status is never read as "none" — an empty allergy list proves nothing.
  const allergyStatus = await currentAllergyStatus(patientId);
  if (allergyStatus.status === "UNKNOWN") {
    flags.push({
      rule: "allergy-status-unknown", severity: "warning",
      message: "Allergy status unknown: no allergies or \"no known allergies\" recorded. Ask about allergies before relying on this check.",
      sourceId: allergyStatus.entryId ?? patientId,
    });
  }

  const activeOrders = await prisma.medicationOrder.findMany({
    where: { patientId, status: { in: ["ORDERED", "PHARMACY_REVIEW", "VERIFIED", "DISPENSED", "ACTIVE"] } },
    orderBy: [{ orderedAt: "asc" }, { id: "asc" }],
  });
  for (const order of activeOrders) {
    const existing = (order.genericName || order.drugName).toLowerCase();
    if (existing !== needle) continue;

    // Phase 3: distinguish an exact duplicate from a route/frequency mismatch on the
    // same drug — both are real, data-derived signals, neither invents interaction knowledge.
    if (route && order.route.toLowerCase() !== route.toLowerCase()) {
      flags.push({
        rule: "route-mismatch",
        severity: "warning",
        message: `Patient already has an active order for ${order.drugName} via a different route (${order.route}).`,
        sourceId: order.id,
      });
    } else if (frequency && order.frequency.toLowerCase() !== frequency.toLowerCase()) {
      flags.push({
        rule: "frequency-mismatch",
        severity: "warning",
        message: `Patient already has an active order for ${order.drugName} at a different frequency (${order.frequency}).`,
        sourceId: order.id,
      });
    } else {
      flags.push({
        rule: "duplicate-active-medication",
        severity: "warning",
        message: `Patient already has an active order for ${order.drugName} (ordered ${order.orderedAt.toISOString().slice(0, 10)}).`,
        sourceId: order.id,
      });
    }
  }

  return flags;
}

/** Persists every flag as an auditable, individually-acknowledgeable MedicationSafetyWarning row (brief §18) — distinct from MedicationOrder.safetyFlags (Phase 0's read-only JSON snapshot, left untouched). */
export async function writeSafetyWarnings(tx: Prisma.TransactionClient, medicationOrderId: string, flags: SafetyFlag[]) {
  if (flags.length === 0) return;
  await tx.medicationSafetyWarning.createMany({
    data: flags.map((f) => ({
      medicationOrderId,
      rule: f.rule,
      severity: (f.severity === "danger" ? "DANGER" : "WARNING") as SafetySeverity,
      message: f.message,
      sourceId: f.sourceId,
    })),
  });
}
