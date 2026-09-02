import { prisma } from "@/lib/db";

/**
 * Discharge barrier engine (brief §38) — computes WHY a patient hasn't
 * left, not just THAT discharge is pending. Deliberately NOT a stored
 * field: barrier state (readiness flags + live pending-order state) can
 * change from many other routes (a lab result finishing, billing marking
 * a flag ready), so a stored "current blockers" column would go stale.
 * Computed live from the same tables every other Phase 1/2 aggregation
 * reads from (docs/CLINICAL_CORE.md §4's established pattern).
 */
export interface DischargeBarrier {
  code: string;
  label: string;
  blocked: boolean;
  detail: string;
}

const READINESS_FLAGS = [
  { key: "clinicallyReady", code: "CLINICAL", label: "Clinical readiness" },
  { key: "documentationReady", code: "DOCUMENTATION", label: "Documentation" },
  { key: "billingReady", code: "BILLING", label: "Billing" },
  { key: "insuranceReady", code: "INSURANCE", label: "Insurance" },
  { key: "pharmacyReady", code: "PHARMACY", label: "Pharmacy" },
  { key: "transportReady", code: "TRANSPORT", label: "Transport" },
] as const;

export async function computeDischargeBarriers(dischargeId: string): Promise<DischargeBarrier[]> {
  const discharge = await prisma.discharge.findUniqueOrThrow({
    where: { id: dischargeId },
    include: { admission: { include: { encounter: true } } },
  });

  const barriers: DischargeBarrier[] = READINESS_FLAGS.map((f) => ({
    code: f.code,
    label: f.label,
    blocked: !discharge[f.key],
    detail: discharge[f.key] ? "Marked ready." : `${f.label} not yet marked ready.`,
  }));

  const encounterId = discharge.admission.encounterId;

  const [pendingLabs, pendingImaging, unacknowledgedCritical, openReferrals] = await Promise.all([
    prisma.labOrder.count({ where: { encounterId, status: { notIn: ["RESULTED", "CANCELLED"] } } }),
    prisma.imagingOrder.count({ where: { encounterId, status: { notIn: ["REPORTED", "CANCELLED"] } } }),
    prisma.labResult.count({ where: { isCritical: true, acknowledgedAt: null, labOrder: { encounterId } } }),
    prisma.referral.count({ where: { encounterId, status: { notIn: ["COMPLETED", "CANCELLED", "REJECTED"] } } }),
  ]);

  barriers.push({
    code: "PENDING_LAB",
    label: "Pending lab results",
    blocked: pendingLabs > 0,
    detail: pendingLabs > 0 ? `${pendingLabs} lab order(s) not yet resulted.` : "No pending lab orders.",
  });
  barriers.push({
    code: "PENDING_IMAGING",
    label: "Pending imaging",
    blocked: pendingImaging > 0,
    detail: pendingImaging > 0 ? `${pendingImaging} imaging order(s) not yet reported.` : "No pending imaging orders.",
  });
  barriers.push({
    code: "CRITICAL_RESULT",
    label: "Unacknowledged critical result",
    blocked: unacknowledgedCritical > 0,
    detail: unacknowledgedCritical > 0 ? `${unacknowledgedCritical} critical lab result(s) unacknowledged.` : "No unacknowledged critical results.",
  });
  barriers.push({
    code: "CONSULT",
    label: "Pending specialist consult",
    blocked: openReferrals > 0,
    detail: openReferrals > 0 ? `${openReferrals} referral(s) not yet completed.` : "No pending referrals.",
  });

  return barriers;
}

/** Bucket a discharge into one actionable work-queue category (brief §40) — the FIRST blocking barrier, or READY_TO_LEAVE if none. */
export function bucketDischarge(barriers: DischargeBarrier[]): { bucket: string; label: string } {
  const blocking = barriers.find((b) => b.blocked);
  if (!blocking) return { bucket: "READY_TO_LEAVE", label: "Ready to leave" };
  const labelByCode: Record<string, string> = {
    CLINICAL: "Medically not ready",
    DOCUMENTATION: "Documentation blocked",
    BILLING: "Billing blocked",
    INSURANCE: "Insurance blocked",
    PHARMACY: "Pharmacy blocked",
    TRANSPORT: "Transport blocked",
    PENDING_LAB: "Pending result",
    PENDING_IMAGING: "Pending result",
    CRITICAL_RESULT: "Pending result",
    CONSULT: "Pending result",
  };
  return { bucket: blocking.code, label: labelByCode[blocking.code] ?? blocking.label };
}
