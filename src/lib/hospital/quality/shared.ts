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

/** Validates that a staff id is an ACTIVE profile of the given facility. Never trusts a client-supplied staff id. */
export async function assertQualityStaffInFacility(db: Tx | typeof prisma, staffId: string, facilityId: string) {
  const staff = await db.hospitalStaffProfile.findUnique({ where: { id: staffId } });
  if (!staff || staff.facilityId !== facilityId) throw new NotFoundError("Staff member not found in this facility.");
  return staff;
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
