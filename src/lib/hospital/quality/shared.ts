import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import type { Prisma } from "@prisma/client";

/**
 * Shared helpers for the Phase B10 Quality / Patient-Safety layer. Every
 * lifecycle is a guarded String state machine (Task/Bed convention, no new
 * enums); the maps below are the single source of legal transitions, exported
 * so they are unit-testable without a database. Every mutation re-validates
 * facility ownership server-side, and any patient/encounter link is validated
 * to belong to the same facility (never a client-trusted id).
 */

export type Tx = Prisma.TransactionClient;

// REPORTED -> TRIAGED -> UNDER_INVESTIGATION -> ACTION_REQUIRED -> RESOLVED -> CLOSED (+CANCELLED).
export const INCIDENT_TRANSITIONS: Record<string, string[]> = {
  REPORTED: ["TRIAGED", "CANCELLED"],
  TRIAGED: ["UNDER_INVESTIGATION", "ACTION_REQUIRED", "RESOLVED", "CANCELLED"],
  UNDER_INVESTIGATION: ["ACTION_REQUIRED", "RESOLVED", "CANCELLED"],
  ACTION_REQUIRED: ["RESOLVED", "CANCELLED"],
  RESOLVED: ["CLOSED", "UNDER_INVESTIGATION"],
  CLOSED: [], // reopening is a separate, explicitly-authorized transition (reopenIncident)
  CANCELLED: [],
};

// OPEN -> IN_PROGRESS -> COMPLETED -> VERIFIED -> CLOSED (+CANCELLED).
export const CAPA_TRANSITIONS: Record<string, string[]> = {
  OPEN: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: ["VERIFIED", "CANCELLED"],
  VERIFIED: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};

// PLANNED -> IN_PROGRESS -> COMPLETED -> CLOSED.
export const AUDIT_TRANSITIONS: Record<string, string[]> = {
  PLANNED: ["IN_PROGRESS", "CLOSED"],
  IN_PROGRESS: ["COMPLETED"],
  COMPLETED: ["CLOSED"],
  CLOSED: [],
};

export const INCIDENT_SEVERITIES = ["LOW", "MODERATE", "HIGH", "CRITICAL"] as const;
export const INCIDENT_CATEGORIES = [
  "MEDICATION", "FALL", "PRESSURE_INJURY", "DIAGNOSTIC", "SURGICAL", "TRANSFUSION",
  "INFECTION", "EQUIPMENT", "OPERATIONAL", "SECURITY", "OTHER",
] as const;

export function isTransitionAllowed(map: Record<string, string[]>, from: string, to: string): boolean {
  return map[from]?.includes(to) ?? false;
}

/**
 * Validates that a staff id is an ACTIVE profile of the given facility. Never
 * trusts a client-supplied staff id. A staff member who has left, been
 * suspended or been deactivated must not be assignable as an investigator,
 * reviewer, auditor or CAPA owner (gate §26), so status is enforced here rather
 * than merely documented.
 */
export async function assertQualityStaffInFacility(db: Tx | typeof prisma, staffId: string, facilityId: string) {
  const staff = await db.hospitalStaffProfile.findUnique({ where: { id: staffId } });
  if (!staff || staff.facilityId !== facilityId) throw new NotFoundError("Staff member not found in this facility.");
  if (staff.status !== "ACTIVE") throw new BadRequestError("That staff member is not active.");
  return staff;
}

const QUALITY_REF_LABELS: Record<string, string> = {
  incidentId: "Quality incident", rcaId: "RCA", capaId: "CAPA action",
  standardId: "Standard", measureId: "Measure", findingId: "Finding",
  auditId: "Audit", departmentId: "Department",
};

/**
 * Every optional parent reference a quality record can carry must be proven to
 * live in the caller's facility before it is written. Without this, a reporter
 * in facility A could attach evidence to — or hang a CAPA/finding off — a
 * record in facility B, a cross-facility write reachable purely by guessing an
 * id (gate §8/§25). Unknown ids are reported as not-found so the endpoint never
 * confirms that a protected record exists in another facility.
 */
export async function assertQualityRefsInFacility(
  db: Tx | typeof prisma,
  facilityId: string,
  refs: Partial<Record<keyof typeof QUALITY_REF_LABELS, string | undefined>>
) {
  const lookups: Record<string, (id: string) => Promise<{ facilityId: string } | null>> = {
    incidentId: (id) => db.qualityIncident.findUnique({ where: { id }, select: { facilityId: true } }),
    rcaId: (id) => db.rootCauseAnalysis.findUnique({ where: { id }, select: { facilityId: true } }),
    capaId: (id) => db.capaAction.findUnique({ where: { id }, select: { facilityId: true } }),
    standardId: (id) => db.qualityStandard.findUnique({ where: { id }, select: { facilityId: true } }),
    measureId: (id) => db.qualityMeasure.findUnique({ where: { id }, select: { facilityId: true } }),
    findingId: (id) => db.qualityFinding.findUnique({ where: { id }, select: { facilityId: true } }),
    auditId: (id) => db.qualityAudit.findUnique({ where: { id }, select: { facilityId: true } }),
    departmentId: (id) => db.department.findUnique({ where: { id }, select: { facilityId: true } }),
  };
  for (const [key, id] of Object.entries(refs)) {
    if (!id) continue;
    const row = await lookups[key](id);
    if (!row || row.facilityId !== facilityId) {
      throw new NotFoundError(`${QUALITY_REF_LABELS[key] ?? "Record"} not found in this facility.`);
    }
  }
}

/** Patient linkage is optional; when present it must belong to the same facility (wrong-patient protection, brief §31). */
export async function assertPatientInFacility(db: Tx | typeof prisma, patientId: string, facilityId: string) {
  const p = await db.patient.findUnique({ where: { id: patientId } });
  if (!p || p.facilityId !== facilityId) throw new NotFoundError("Patient not found in this facility.");
  return p;
}

/** An encounter, when linked, must belong to both the patient and the facility. */
export async function assertEncounterInFacility(db: Tx | typeof prisma, encounterId: string, facilityId: string, patientId?: string) {
  const e = await db.encounter.findUnique({ where: { id: encounterId } });
  if (!e || e.facilityId !== facilityId) throw new NotFoundError("Encounter not found in this facility.");
  if (patientId && e.patientId !== patientId) throw new BadRequestError("Encounter does not belong to that patient.");
  return e;
}
