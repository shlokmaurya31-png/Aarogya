import { prisma } from "@/lib/db";
import { requirePermission, UnauthorizedError, ForbiddenError } from "./rbac";
import { selfPatientIds } from "@/lib/person/self";

/**
 * Self-service boundary for Role.PATIENT accounts (Phase 1 — see
 * docs/CLINICAL_CORE.md §7). A patient may only ever read their own
 * record — this is a fundamentally different "tenant" shape than
 * requireFacilityStaff()'s facility scoping (one individual, not one
 * organization), so it gets its own function rather than being folded
 * into hospitalRbac.ts.
 */
export async function requirePatientSelf(requestedPatientId?: string | null) {
  const session = await requirePermission("patient:self:read");
  // Phase 0: the caller's records are their Person's ACTIVE links. With no
  // record asked for, the oldest link (a person usually has one).
  const own = await selfPatientIds(session.userId);
  const id = requestedPatientId ? own.find((p) => p === requestedPatientId) : own[0];
  if (!id) throw new UnauthorizedError();
  const patient = await prisma.patient.findUnique({ where: { id } });
  if (!patient) throw new UnauthorizedError();
  if (patient.mergedIntoId) {
    // A merged (superseded) patient record's own login, if it somehow still exists,
    // should not present a "live" record — redirect callers to the merge target.
    throw new ForbiddenError("patient:self:read");
  }
  return { session, patient };
}
