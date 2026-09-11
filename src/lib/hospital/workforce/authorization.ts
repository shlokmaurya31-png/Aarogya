import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

/**
 * Phase B10 credential-aware authorization FOUNDATION. This does NOT replace
 * RBAC or facility isolation — it is an ADDITIONAL predicate layered on top of
 * requirePermission()/requireFacilityStaff(). The question it answers is:
 * "does this staff member ALSO hold the active credential / privilege that this
 * specific high-risk operation requires?" A role alone (DOCTOR, PHARMACIST,
 * LAB_TECHNICIAN, ...) is deliberately not sufficient for the operations wired
 * to these checks. See docs — this is a foundation applied to representative
 * high-risk workflows only; existing RBAC stays backwards-compatible.
 *
 * Expiry is DERIVED from dates at read time (brief §39) — a privilege/credential
 * past its expiry is treated as expired even if a sweeper has not flipped its
 * status column, and nothing here mutates records just because a date passed.
 */

export type Db = Prisma.TransactionClient | typeof prisma;

/** Reason codes surfaced when a credential/privilege predicate fails (brief §23). */
export type AuthzFailureReason =
  | "INACTIVE_STAFF" | "WRONG_FACILITY" | "MISSING_CREDENTIAL" | "EXPIRED_CREDENTIAL"
  | "SUSPENDED_CREDENTIAL" | "MISSING_PRIVILEGE" | "EXPIRED_PRIVILEGE"
  | "SUSPENDED_PRIVILEGE" | "REVOKED_PRIVILEGE" | "UNAVAILABLE_STAFF";

/**
 * A 403 that carries a specific reason code. Deliberately does NOT extend the
 * permission-typed ForbiddenError — this is a credential/privilege failure, not
 * a missing-RBAC-permission failure — but exposes the same `status = 403` so
 * withApiErrors() maps it identically.
 */
export class CredentialAuthorizationError extends Error {
  readonly status = 403 as const;
  readonly reason: AuthzFailureReason;
  constructor(reason: AuthzFailureReason, message: string) {
    super(message);
    this.name = "CredentialAuthorizationError";
    this.reason = reason;
  }
}

export type CredentialState = "ACTIVE" | "EXPIRING_SOON" | "EXPIRED";

/** Derived expiry classification for a dated credential/privilege (brief §39). */
export function deriveExpiryState(expiresAt: Date | null | undefined, now = new Date(), soonDays = 30): CredentialState {
  if (!expiresAt) return "ACTIVE";
  const ms = expiresAt.getTime() - now.getTime();
  if (ms <= 0) return "EXPIRED";
  if (ms <= soonDays * 24 * 3600_000) return "EXPIRING_SOON";
  return "ACTIVE";
}

/** A staff member's canonical facility assignment IS an authorization input (brief §14). */
export async function isStaffAssignedToFacility(db: Db, staffId: string, facilityId: string): Promise<boolean> {
  const staff = await db.hospitalStaffProfile.findUnique({ where: { id: staffId } });
  return !!staff && staff.facilityId === facilityId;
}

export async function isStaffOperationallyActive(db: Db, staffId: string, facilityId: string): Promise<boolean> {
  const staff = await db.hospitalStaffProfile.findUnique({ where: { id: staffId } });
  return !!staff && staff.facilityId === facilityId && staff.status === "ACTIVE";
}

/** Availability defaults to available when no record exists (roster is a foundation, not mandatory). */
export async function isStaffAvailable(db: Db, staffId: string, facilityId: string): Promise<boolean> {
  const rec = await db.staffAvailability.findUnique({ where: { staffId } });
  if (!rec || rec.facilityId !== facilityId) return true;
  return rec.availability === "AVAILABLE" || rec.availability === "OFF_DUTY" ? rec.availability === "AVAILABLE" : false;
}

export async function hasActiveCredential(db: Db, staffId: string, facilityId: string, credentialType: string): Promise<boolean> {
  const creds = await db.credential.findMany({ where: { staffId, facilityId, credentialType } });
  return creds.some((c) => c.status === "VERIFIED" && deriveExpiryState(c.expiresAt) !== "EXPIRED");
}

export async function hasActivePrivilege(db: Db, staffId: string, facilityId: string, privilegeType: string): Promise<boolean> {
  const privs = await db.staffPrivilege.findMany({ where: { staffId, facilityId, privilegeType } });
  return privs.some((p) => p.status === "ACTIVE" && deriveExpiryState(p.expiresAt) !== "EXPIRED");
}

/**
 * Assert that a staff member holds an active privilege of the given type in the
 * given facility. Throws a CredentialAuthorizationError with a specific reason
 * (brief §23) — sensitive credential detail is not leaked. Enforces staff
 * active-in-facility first (so a suspended/cross-facility staff is blocked
 * before any privilege lookup).
 */
export async function requirePrivilege(db: Db, args: { staffId: string; facilityId: string; privilegeType: string }): Promise<void> {
  const staff = await db.hospitalStaffProfile.findUnique({ where: { id: args.staffId } });
  if (!staff || staff.facilityId !== args.facilityId) throw new CredentialAuthorizationError("WRONG_FACILITY", "Not authorized in this facility.");
  if (staff.status !== "ACTIVE") throw new CredentialAuthorizationError("INACTIVE_STAFF", "Staff member is not active.");
  const privs = await db.staffPrivilege.findMany({ where: { staffId: args.staffId, facilityId: args.facilityId, privilegeType: args.privilegeType } });
  if (privs.length === 0) throw new CredentialAuthorizationError("MISSING_PRIVILEGE", "Required clinical privilege has not been granted.");
  if (privs.some((p) => p.status === "REVOKED")) {
    if (!privs.some((p) => p.status === "ACTIVE")) throw new CredentialAuthorizationError("REVOKED_PRIVILEGE", "Required clinical privilege has been revoked.");
  }
  // Pick an ACTIVE *and* unexpired grant. Selecting the first ACTIVE row and
  // only then testing its expiry wrongly denied a staff member who holds a
  // superseded expired grant alongside a current one — and disagreed with
  // hasActivePrivilege(), which already uses this predicate.
  const active = privs.find((p) => p.status === "ACTIVE" && deriveExpiryState(p.expiresAt) !== "EXPIRED");
  if (!active) {
    if (privs.some((p) => p.status === "ACTIVE")) throw new CredentialAuthorizationError("EXPIRED_PRIVILEGE", "Required clinical privilege has expired.");
    if (privs.some((p) => p.status === "SUSPENDED")) throw new CredentialAuthorizationError("SUSPENDED_PRIVILEGE", "Required clinical privilege is suspended.");
    throw new CredentialAuthorizationError("EXPIRED_PRIVILEGE", "Required clinical privilege is not active.");
  }
}

export async function requireCredential(db: Db, args: { staffId: string; facilityId: string; credentialType: string }): Promise<void> {
  const staff = await db.hospitalStaffProfile.findUnique({ where: { id: args.staffId } });
  if (!staff || staff.facilityId !== args.facilityId) throw new CredentialAuthorizationError("WRONG_FACILITY", "Not authorized in this facility.");
  if (staff.status !== "ACTIVE") throw new CredentialAuthorizationError("INACTIVE_STAFF", "Staff member is not active.");
  const creds = await db.credential.findMany({ where: { staffId: args.staffId, facilityId: args.facilityId, credentialType: args.credentialType } });
  if (creds.length === 0) throw new CredentialAuthorizationError("MISSING_CREDENTIAL", "Required credential is missing.");
  if (!creds.some((c) => c.status === "VERIFIED")) {
    if (creds.some((c) => c.status === "SUSPENDED" || c.status === "REVOKED")) throw new CredentialAuthorizationError("SUSPENDED_CREDENTIAL", "Required credential is suspended or revoked.");
    throw new CredentialAuthorizationError("MISSING_CREDENTIAL", "Required credential is not verified.");
  }
  // Same correction as requirePrivilege: accept any VERIFIED-and-unexpired
  // credential rather than testing whichever VERIFIED row happened to come back
  // first, so a renewed registration alongside its expired predecessor passes.
  if (!creds.some((c) => c.status === "VERIFIED" && deriveExpiryState(c.expiresAt) !== "EXPIRED")) {
    throw new CredentialAuthorizationError("EXPIRED_CREDENTIAL", "Required credential has expired.");
  }
}

/**
 * Route-layer convenience: enforce a privilege for a FacilityContext produced by
 * requireFacilityStaff(). AAROGYA_ADMIN (cross-facility admin, no staff profile)
 * is exempt — it already has explicit cross-facility authority and holds no
 * per-facility privilege rows. Enforcement is opt-in per high-risk route.
 */
export async function enforcePrivilegeForContext(ctx: { staff: { id: string } | null; facilityId: string }, privilegeType: string): Promise<void> {
  if (!ctx.staff) return; // AAROGYA_ADMIN
  await requirePrivilege(prisma, { staffId: ctx.staff.id, facilityId: ctx.facilityId, privilegeType });
}
