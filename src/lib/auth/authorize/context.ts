import { prisma } from "@/lib/db";
import { requireSession } from "../rbac";
import { sessionAuthAgeMs } from "../session";
import type { AuthorizationActor } from "./types";

/**
 * Phase C4 — build the authorization actor from the authenticated session.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THIS IS THE CHOKEPOINT FOR ACTOR IDENTITY.
 *
 * Every attribute the engine reasons about — user, role, staff id, staff
 * status, facility — is read HERE, from the session and the database. None of
 * it is ever taken from a request body, a query string, a route parameter, a
 * FHIR payload or an ABDM callback.
 *
 * That is what makes "never trust client-supplied facilityId / actorId / role"
 * enforceable rather than aspirational: there is simply no code path by which a
 * client-supplied value reaches the engine.
 *
 * `requestedFacilityId` exists solely for AAROGYA_ADMIN, which has no staff
 * profile and therefore no implicit facility. For every other role the
 * parameter is IGNORED, exactly as requireFacilityStaff already behaves.
 * ════════════════════════════════════════════════════════════════════════════
 */
export async function buildAuthorizationActor(
  requestedFacilityId?: string
): Promise<AuthorizationActor> {
  const session = await requireSession();
  const authAgeMs = sessionAuthAgeMs(session);

  if (session.role === "AAROGYA_ADMIN") {
    return {
      userId: session.userId,
      role: session.role,
      staffId: null,
      staffStatus: null,
      // Platform administration is explicitly cross-facility; the engine still
      // applies every clinical check on top of it.
      facilityId: requestedFacilityId ?? null,
      authAgeMs,
    };
  }

  const staff = await prisma.hospitalStaffProfile.findUnique({
    where: { userId: session.userId },
    select: { id: true, facilityId: true, status: true, departmentId: true },
  });

  return {
    userId: session.userId,
    role: session.role,
    staffId: staff?.id ?? null,
    staffStatus: staff?.status ?? null,
    // Derived from the staff profile. A requested facility is NOT honoured here.
    facilityId: staff?.facilityId ?? null,
    departmentId: staff?.departmentId ?? null,
    authAgeMs,
  };
}

/**
 * Resolve the patient a Role.PATIENT session belongs to, for self-service
 * scoping. Returns null for staff sessions.
 */
export async function resolveSelfPatient(actor: AuthorizationActor): Promise<{ id: string; facilityId: string } | null> {
  if (actor.role !== "PATIENT") return null;
  const patient = await prisma.patient.findUnique({
    where: { userId: actor.userId },
    select: { id: true, facilityId: true, mergedIntoId: true },
  });
  if (!patient) return null;
  // A merged (superseded) record must not present itself as live.
  if (patient.mergedIntoId) return null;
  return { id: patient.id, facilityId: patient.facilityId };
}
