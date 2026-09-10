import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import type { Prisma } from "@prisma/client";

/**
 * Shared helpers for the Phase B9 Hospital Operations layer. All lifecycles are
 * guarded String state machines (no new enums, migration stays additive); the
 * maps below are the single source of legal transitions, exported so they are
 * unit-testable without a database. Every operational mutation re-validates
 * facility ownership server-side, and any staff assignment is validated to be an
 * ACTIVE staff member of the same facility (never a client-trusted id).
 */

export type Tx = Prisma.TransactionClient;

export const HOUSEKEEPING_TRANSITIONS: Record<string, string[]> = {
  REQUESTED: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: ["INSPECTED", "CLOSED"],
  INSPECTED: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};

export const TRANSPORT_TRANSITIONS: Record<string, string[]> = {
  REQUESTED: ["ACCEPTED", "ASSIGNED", "REJECTED", "CANCELLED"],
  ACCEPTED: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["EN_ROUTE_TO_PICKUP", "CANCELLED"],
  EN_ROUTE_TO_PICKUP: ["PATIENT_PICKED_UP", "CANCELLED"],
  PATIENT_PICKED_UP: ["IN_TRANSIT", "CANCELLED"],
  IN_TRANSIT: ["ARRIVED"],
  ARRIVED: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
  REJECTED: [],
};

export const AMBULANCE_TRIP_TRANSITIONS: Record<string, string[]> = {
  REQUESTED: ["DISPATCHED", "CANCELLED", "FAILED_DISPATCH"],
  DISPATCHED: ["EN_ROUTE", "CANCELLED"],
  EN_ROUTE: ["AT_PICKUP", "CANCELLED"],
  AT_PICKUP: ["PATIENT_ONBOARD", "CANCELLED"],
  PATIENT_ONBOARD: ["IN_TRANSIT"],
  IN_TRANSIT: ["ARRIVED"],
  ARRIVED: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
  FAILED_DISPATCH: [],
};

export const MEAL_TRANSITIONS: Record<string, string[]> = {
  PLANNED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"],
  READY: ["DELIVERED", "REFUSED", "MISSED", "CANCELLED"],
  DELIVERED: [],
  REFUSED: [],
  MISSED: [],
  CANCELLED: [],
};

export const MAINTENANCE_TRANSITIONS: Record<string, string[]> = {
  REPORTED: ["TRIAGED", "ASSIGNED", "CANCELLED"],
  TRIAGED: ["ASSIGNED", "CANCELLED"],
  ASSIGNED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["RESOLVED", "CANCELLED"],
  RESOLVED: ["VERIFIED", "CLOSED"],
  VERIFIED: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};

export const INFECTION_TRANSITIONS: Record<string, string[]> = {
  REPORTED: ["UNDER_REVIEW", "CANCELLED"],
  UNDER_REVIEW: ["INVESTIGATION", "ACTION_REQUIRED", "RESOLVED", "CANCELLED"],
  INVESTIGATION: ["ACTION_REQUIRED", "RESOLVED"],
  ACTION_REQUIRED: ["RESOLVED"],
  RESOLVED: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};

export function isTransitionAllowed(map: Record<string, string[]>, from: string, to: string): boolean {
  return map[from]?.includes(to) ?? false;
}

/** Validates that a staff id is an ACTIVE profile of the given facility. Never trusts a client-supplied staff id. */
export async function assertStaffActiveInFacility(db: Tx | typeof prisma, staffId: string, facilityId: string) {
  const staff = await db.hospitalStaffProfile.findUnique({ where: { id: staffId } });
  if (!staff || staff.facilityId !== facilityId) throw new NotFoundError("Staff member not found in this facility.");
  if (staff.status !== "ACTIVE") throw new BadRequestError("Staff member is not active.");
  return staff;
}
