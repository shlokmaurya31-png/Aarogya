import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { requireSession, ForbiddenError, NotFoundError } from "@/lib/auth/rbac";
import { roleHasPermission } from "@/lib/auth/permissions";
import type { SessionPayload } from "@/lib/auth/session";
import { resolvePatientIdsForRead } from "./merge";

/**
 * Phase D11 — the patient identity boundary.
 *
 * This module is the ONE place that answers "which patient records may THIS
 * authenticated caller see, and what may they do to them?" Every patient-facing
 * route derives its patient scope here and NEVER trusts a browser-supplied
 * patientId/userId/delegateId (brief §3, §37, §43). A cross-account or
 * unauthorized target is reported 404-shaped (NotFoundError) so that "you may
 * not see this" is indistinguishable from "this does not exist" — the same
 * anti-enumeration posture C4 uses for cross-facility denials.
 *
 * Two access shapes, deliberately asymmetric:
 *   • SELF      — the caller's own linked Patient. Full non-restricted access,
 *                 and the ONLY shape that may take self-service actions.
 *   • DELEGATE  — access another patient granted (family/caregiver), bounded to
 *                 the delegation's scopes, ACTIVE + unexpired only, READ-ONLY.
 *                 A delegate can never act, never escalate scope, never grant
 *                 (brief §26, §27) — the patient acts, the delegate observes.
 */

/** Coarse patient-facing data classes used for delegated-scope gating. */
export type PatientDataClass =
  | "PERSONAL"
  | "APPOINTMENTS"
  | "QUEUE"
  | "RECORDS"
  | "REPORTS"
  | "PRESCRIPTIONS"
  | "MEDICATIONS"
  | "BILLING"
  | "INSURANCE"
  | "CONSENT";

/** Delegation scope string -> the data classes it authorizes a delegate to read. */
const SCOPE_TO_CLASSES: Record<string, PatientDataClass[]> = {
  APPOINTMENTS: ["APPOINTMENTS", "QUEUE"],
  RECORDS: ["RECORDS", "PERSONAL"],
  REPORTS: ["REPORTS"],
  PRESCRIPTIONS: ["PRESCRIPTIONS"],
  MEDICATIONS: ["MEDICATIONS"],
  BILLING: ["BILLING"],
  INSURANCE: ["INSURANCE"],
  CONSENT: ["CONSENT"],
};

export const DELEGATION_SCOPES = Object.keys(SCOPE_TO_CLASSES);
export const DELEGATION_RELATIONSHIPS = ["PARENT", "CHILD", "SPOUSE", "GUARDIAN", "CAREGIVER", "OTHER"] as const;

/** A resolved, authorized view onto exactly one patient record. */
export interface PatientAccessScope {
  /** Canonical primary patient id being accessed. */
  patientId: string;
  /** Merge-aware id set (self + any patients merged INTO this one) for reads. */
  patientIds: string[];
  /** Facility the patient belongs to (server-derived; drives tenant scoping). */
  facilityId: string;
  isSelf: boolean;
  /** Present only for a delegated view. */
  delegationId?: string;
  /** Data classes this caller may read for this patient. Self => all. */
  allowedClasses: Set<PatientDataClass>;
}

export interface PatientContext {
  session: SessionPayload;
  userId: string;
  /** The caller's own linked patient, if any (a pure caregiver may have none). */
  selfPatientId: string | null;
}

/**
 * Authenticates the caller for the patient experience. Requires a valid,
 * non-revoked session AND the base patient self-read permission — i.e. a
 * PATIENT-role account. Staff/admin roles are refused: the patient portal is
 * not an alternate clinical console.
 */
export async function requirePatientContext(): Promise<PatientContext> {
  const session = await requireSession();
  if (!roleHasPermission(session.role, "patient:self:read")) {
    throw new ForbiddenError("patient:self:read");
  }
  const self = await prisma.patient.findUnique({
    where: { userId: session.userId },
    select: { id: true, mergedIntoId: true },
  });
  // A merged (superseded) own-record must not present as live (matches
  // requirePatientSelf) — the caller should be re-pointed at the merge target,
  // which we do not auto-follow here to avoid silently switching identities.
  const selfPatientId = self && !self.mergedIntoId ? self.id : null;
  return { session, userId: session.userId, selfPatientId };
}

/** Requires the caller additionally hold the self-service action permission. */
export async function requirePatientActor(): Promise<PatientContext> {
  const ctx = await requirePatientContext();
  if (!roleHasPermission(ctx.session.role, "patient:self:manage")) {
    throw new ForbiddenError("patient:self:manage");
  }
  return ctx;
}

interface AccessiblePatient {
  patientId: string;
  isSelf: boolean;
  relationship: string; // "SELF" for own record
  delegationId?: string;
  scopes: string[]; // delegation scopes; [] for self (meaning "all")
}

/**
 * The full set of patients this caller may access right now: their own record
 * plus every ACTIVE, unexpired delegation granted TO them. Expired-but-not-yet-
 * swept delegations are filtered here at read time, so revocation/expiry take
 * effect immediately regardless of any background sweep.
 */
export async function listAccessiblePatients(ctx: PatientContext): Promise<AccessiblePatient[]> {
  const out: AccessiblePatient[] = [];
  if (ctx.selfPatientId) {
    out.push({ patientId: ctx.selfPatientId, isSelf: true, relationship: "SELF", scopes: [] });
  }
  const now = new Date();
  const delegations = await prisma.patientDelegation.findMany({
    where: {
      delegateUserId: ctx.userId,
      status: "ACTIVE",
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    include: { scopes: true },
  });
  for (const d of delegations) {
    // Never let a delegate observe their own record via the delegate path.
    if (d.patientId === ctx.selfPatientId) continue;
    out.push({
      patientId: d.patientId,
      isSelf: false,
      relationship: d.relationship,
      delegationId: d.id,
      scopes: d.scopes.map((s) => s.scope),
    });
  }
  return out;
}

function classesForScopes(scopes: string[]): Set<PatientDataClass> {
  const set = new Set<PatientDataClass>();
  for (const s of scopes) for (const c of SCOPE_TO_CLASSES[s] ?? []) set.add(c);
  return set;
}

const ALL_CLASSES = new Set<PatientDataClass>([
  "PERSONAL", "APPOINTMENTS", "QUEUE", "RECORDS", "REPORTS",
  "PRESCRIPTIONS", "MEDICATIONS", "BILLING", "INSURANCE", "CONSENT",
]);

/**
 * Resolves the patient a READ should target. With no requestedPatientId the
 * caller's own record is used. A requestedPatientId is honored ONLY if it is in
 * the caller's accessible set; anything else — a stranger's id, a revoked
 * delegation, a fabricated id — is 404-shaped. Never trusts the client id as an
 * authorization input (brief §17, §37, §54).
 */
export async function resolveReadScope(
  ctx: PatientContext,
  requestedPatientId?: string | null,
): Promise<PatientAccessScope> {
  const accessible = await listAccessiblePatients(ctx);
  let match: AccessiblePatient | undefined;
  if (!requestedPatientId) {
    match = accessible.find((a) => a.isSelf) ?? undefined;
  } else {
    match = accessible.find((a) => a.patientId === requestedPatientId);
  }
  if (!match) throw new NotFoundError();

  const patient = await prisma.patient.findUnique({
    where: { id: match.patientId },
    select: { id: true, facilityId: true, mergedIntoId: true },
  });
  if (!patient || patient.mergedIntoId) throw new NotFoundError();

  const patientIds = await resolvePatientIdsForRead(match.patientId);
  return {
    patientId: match.patientId,
    patientIds,
    facilityId: patient.facilityId,
    isSelf: match.isSelf,
    delegationId: match.delegationId,
    allowedClasses: match.isSelf ? new Set(ALL_CLASSES) : classesForScopes(match.scopes),
  };
}

/**
 * Resolves the patient a self-service ACTION should target and asserts the
 * caller may act. Only the SELF record is ever actionable — a delegate is
 * strictly read-only (brief §27). Reported 404-shaped when the target is not
 * the caller's own record, so a delegate cannot even probe which actions exist.
 */
export async function resolveActScope(
  ctx: PatientContext,
  requestedPatientId?: string | null,
): Promise<PatientAccessScope> {
  const scope = await resolveReadScope(ctx, requestedPatientId);
  if (!scope.isSelf) throw new NotFoundError();
  return scope;
}

/** Throws 404-shaped unless the resolved scope may read the given data class. */
export function assertClass(scope: PatientAccessScope, dataClass: PatientDataClass): void {
  if (!scope.allowedClasses.has(dataClass)) throw new NotFoundError();
}

/** SHA-256 hash of a single-use invitation token (we never store the token). */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
