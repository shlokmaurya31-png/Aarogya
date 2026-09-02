import { prisma } from "@/lib/db";
import { requirePermission, UnauthorizedError, ForbiddenError } from "./rbac";

/**
 * Self-service boundary for Role.PATIENT accounts (Phase 1 — see
 * docs/CLINICAL_CORE.md §7). A patient may only ever read their own
 * record — this is a fundamentally different "tenant" shape than
 * requireFacilityStaff()'s facility scoping (one individual, not one
 * organization), so it gets its own function rather than being folded
 * into hospitalRbac.ts.
 */
export async function requirePatientSelf() {
  const session = await requirePermission("patient:self:read");
  const patient = await prisma.patient.findUnique({ where: { userId: session.userId } });
  if (!patient) throw new UnauthorizedError();
  if (patient.mergedIntoId) {
    // A merged (superseded) patient record's own login, if it somehow still exists,
    // should not present a "live" record — redirect callers to the merge target.
    throw new ForbiddenError("patient:self:read");
  }
  return { session, patient };
}
