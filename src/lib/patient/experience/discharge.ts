import { prisma } from "@/lib/db";
import { assertClass, type PatientAccessScope } from "../context";

/**
 * Phase D11 — patient-facing discharge & follow-up (brief §21, §22).
 *
 * Read-only. Discharge remains a hospital-controlled workflow — the patient can
 * NEVER mark themselves discharged. This projects the canonical Discharge record
 * into a patient-safe view: status, date, whether a discharge summary is
 * available, and which items are still pending patient/hospital action. Follow-up
 * shows recorded clinician recommendations only — never invented advice.
 */

export interface DischargeDTO {
  admittedAt: string | null;
  dischargedAt: string | null;
  isDischarged: boolean;
  summaryAvailable: boolean;
  pending: string[]; // patient-readable labels for outstanding readiness items
}

const READINESS_LABELS: { key: keyof PickReady; label: string }[] = [
  { key: "clinicallyReady", label: "Medical clearance" },
  { key: "documentationReady", label: "Discharge paperwork" },
  { key: "billingReady", label: "Billing settlement" },
  { key: "insuranceReady", label: "Insurance approval" },
  { key: "pharmacyReady", label: "Take-home medicines" },
  { key: "transportReady", label: "Transport arrangement" },
];
type PickReady = {
  clinicallyReady: boolean; documentationReady: boolean; billingReady: boolean;
  insuranceReady: boolean; pharmacyReady: boolean; transportReady: boolean;
};

export async function listDischarges(scope: PatientAccessScope): Promise<DischargeDTO[]> {
  assertClass(scope, "RECORDS");
  const discharges = await prisma.discharge.findMany({
    where: { admission: { encounter: { patientId: { in: scope.patientIds } } } },
    orderBy: { initiatedAt: "desc" },
    take: 25,
    include: { admission: { select: { admittedAt: true } } },
  });
  return discharges.map((d) => ({
    admittedAt: d.admission?.admittedAt?.toISOString() ?? null,
    dischargedAt: d.dischargedAt?.toISOString() ?? null,
    isDischarged: Boolean(d.dischargedAt),
    summaryAvailable: d.dischargeSummary != null,
    pending: d.dischargedAt
      ? []
      : READINESS_LABELS.filter((r) => !(d as unknown as PickReady)[r.key]).map((r) => r.label),
  }));
}
