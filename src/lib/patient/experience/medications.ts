import { prisma } from "@/lib/db";
import { patientLanguage as L } from "./language";
import { assertClass, type PatientAccessScope } from "../context";

/**
 * Phase D11 — prescriptions & medications (brief §19, §20).
 *
 * Strictly READ-ONLY: a patient never modifies a clinician-authored order. The
 * status shown is the canonical MedicationOrder.status, translated to patient
 * language — we never INFER "active medication" or adherence from the mere
 * existence of an order (brief §20). Prescriptions and the medication list are
 * two lenses on the same canonical table, not two data stores.
 */

const ACTIVE_MED_STATUSES = ["ORDERED", "VERIFIED", "DISPENSED", "ACTIVE"];

export interface PrescriptionDTO {
  id: string;
  drug: string;
  dose: string;
  frequency: string;
  route: string;
  durationDays: number | null;
  statusLabel: string;
  prescribedBy: string;
  orderedAt: string;
}

export interface MedicationDTO {
  id: string;
  drug: string;
  dose: string;
  frequency: string;
  statusLabel: string;
  isActive: boolean;
  orderedAt: string;
}

export async function listPrescriptions(scope: PatientAccessScope): Promise<PrescriptionDTO[]> {
  assertClass(scope, "PRESCRIPTIONS");
  const orders = await prisma.medicationOrder.findMany({
    where: { patientId: { in: scope.patientIds } },
    orderBy: { orderedAt: "desc" },
    take: 100,
    include: { orderedBy: { include: { user: { select: { displayName: true } } } } },
  });
  return orders.map((o) => ({
    id: o.id,
    drug: o.drugName,
    dose: o.dose,
    frequency: o.frequency,
    route: o.route,
    durationDays: o.durationDays,
    statusLabel: L.medicationStatus(o.status),
    prescribedBy: o.orderedBy?.user?.displayName ?? "Care team",
    orderedAt: o.orderedAt.toISOString(),
  }));
}

export async function listMedications(scope: PatientAccessScope): Promise<MedicationDTO[]> {
  assertClass(scope, "MEDICATIONS");
  const orders = await prisma.medicationOrder.findMany({
    where: { patientId: { in: scope.patientIds } },
    orderBy: { orderedAt: "desc" },
    take: 100,
  });
  return orders.map((o) => ({
    id: o.id,
    drug: o.drugName,
    dose: o.dose,
    frequency: o.frequency,
    statusLabel: L.medicationStatus(o.status),
    // "Active" reflects canonical status ONLY — never inferred adherence.
    isActive: ACTIVE_MED_STATUSES.includes(o.status),
    orderedAt: o.orderedAt.toISOString(),
  }));
}
