import { prisma } from "@/lib/db";

/**
 * Clinical decision support — deliberately narrow (brief §20/§101): allergy
 * conflict and duplicate active medication only. Both are checkable from
 * data this prototype actually has; a real drug-interaction/renal-dosing/
 * sepsis-risk engine needs reference data this build doesn't include (see
 * docs/ENTERPRISE_HOSPITAL_ARCHITECTURE.md §8). Every flag is transparent,
 * traceable to its source row, and requires an explicit override reason to
 * proceed — never a silent block, never a silent allow.
 */
export interface SafetyFlag {
  rule: "allergy-conflict" | "duplicate-active-medication";
  severity: "warning" | "danger";
  message: string;
  sourceId: string;
}

export async function checkMedicationSafety(patientId: string, drugName: string, genericName?: string): Promise<SafetyFlag[]> {
  const flags: SafetyFlag[] = [];
  const needle = (genericName || drugName).toLowerCase();

  const allergies = await prisma.allergy.findMany({ where: { patientId } });
  for (const allergy of allergies) {
    const substance = allergy.substance.toLowerCase();
    if (needle.includes(substance) || substance.includes(needle)) {
      flags.push({
        rule: "allergy-conflict",
        severity: allergy.severity === "severe" ? "danger" : "warning",
        message: `Patient has a documented ${allergy.severity} allergy to "${allergy.substance}"${allergy.reaction ? ` (reaction: ${allergy.reaction})` : ""}.`,
        sourceId: allergy.id,
      });
    }
  }

  const activeOrders = await prisma.medicationOrder.findMany({
    where: { patientId, status: { in: ["ORDERED", "VERIFIED", "DISPENSED"] } },
  });
  for (const order of activeOrders) {
    const existing = (order.genericName || order.drugName).toLowerCase();
    if (existing === needle) {
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
