import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import {
  hashInviteToken,
  DELEGATION_SCOPES,
  DELEGATION_RELATIONSHIPS,
  type PatientAccessScope,
  type PatientContext,
} from "../context";

/**
 * Phase D11 — family / caregiver delegated access (brief §26, §27, §55).
 *
 * The strictest surface in D11. Invariants, each enforced here and proven by the
 * gate:
 *   • Only the patient (grantor, scope.isSelf) may invite or revoke. A delegate
 *     can never grant themselves access or escalate scope.
 *   • Scope is fixed AT INVITE and never changed on accept — acceptance binds a
 *     user to an existing grant, it cannot widen it.
 *   • The invite token is single-use; only its SHA-256 hash is stored. A lookup
 *     miss and a scope miss are indistinguishable (anti-enumeration).
 *   • Revocation / expiry takes effect immediately (listAccessiblePatients only
 *     ever returns ACTIVE + unexpired), so no stale access survives.
 *   • Accept/revoke are guarded (status+version CAS) so concurrent attempts
 *     cannot double-apply.
 */

const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days to accept

export interface DelegateGrantDTO {
  id: string;
  delegateName: string | null;
  invitedContact: string | null;
  relationship: string;
  scopes: string[];
  status: string;
  expiresAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
}

/** Delegations the patient has granted over their OWN record (grantor view). */
export async function listGrantedDelegations(scope: PatientAccessScope): Promise<DelegateGrantDTO[]> {
  if (!scope.isSelf) throw new NotFoundError();
  const rows = await prisma.patientDelegation.findMany({
    where: { patientId: scope.patientId, status: { not: "EXPIRED" } },
    orderBy: { createdAt: "desc" },
    include: { scopes: true, delegate: { select: { displayName: true } } },
  });
  return rows.map((d) => ({
    id: d.id,
    delegateName: d.delegate?.displayName ?? d.invitedName ?? null,
    invitedContact: d.invitedContact,
    relationship: d.relationship,
    scopes: d.scopes.map((s) => s.scope),
    status: d.status,
    expiresAt: d.expiresAt?.toISOString() ?? null,
    acceptedAt: d.acceptedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  }));
}

/**
 * Invite a delegate. Returns the single-use token ONCE — it is delivered to the
 * invitee out of band and never stored in plaintext. Validates scopes and
 * relationship against closed allow-lists; a scope outside the allow-list is
 * rejected (a delegate can never be granted an un-modelled capability).
 */
export async function inviteDelegate(
  scope: PatientAccessScope,
  actorUserId: string,
  input: { relationship: string; scopes: string[]; invitedContact: string; invitedName?: string; expiresAt?: string },
): Promise<{ delegationId: string; inviteToken: string }> {
  if (!scope.isSelf) throw new NotFoundError();
  if (!DELEGATION_RELATIONSHIPS.includes(input.relationship as (typeof DELEGATION_RELATIONSHIPS)[number])) {
    throw new BadRequestError("Unknown relationship type.");
  }
  const scopes = [...new Set(input.scopes ?? [])];
  if (scopes.length === 0) throw new BadRequestError("Select at least one thing to share.");
  for (const s of scopes) {
    if (!DELEGATION_SCOPES.includes(s)) throw new BadRequestError(`Unknown sharing scope: ${s}.`);
  }
  if (!input.invitedContact?.trim()) throw new BadRequestError("A contact for the invitation is required.");
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : undefined;
  if (expiresAt && expiresAt.getTime() <= Date.now()) throw new BadRequestError("Expiry must be in the future.");

  const token = randomBytes(32).toString("base64url");
  const inviteTokenHash = hashInviteToken(token);

  const delegation = await prisma.patientDelegation.create({
    data: {
      patientId: scope.patientId,
      relationship: input.relationship,
      status: "INVITED",
      inviteTokenHash,
      invitedContact: input.invitedContact.trim(),
      invitedName: input.invitedName?.trim(),
      inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
      expiresAt,
      createdByUserId: actorUserId,
      scopes: { create: scopes.map((s) => ({ scope: s })) },
    },
  });
  await recordAuditEvent("patient.delegation.invited", actorUserId, {
    delegationId: delegation.id, patientId: scope.patientId, relationship: input.relationship, scopes,
  }, { patientId: scope.patientId, facilityId: scope.facilityId });

  return { delegationId: delegation.id, inviteToken: token };
}

/**
 * Accept an invitation as the authenticated caller. Binds the caller as the
 * delegate WITHOUT changing scope. Guarded so two concurrent accepts cannot both
 * win. A caller can never accept a delegation that would let them observe their
 * own record via the delegate path, and cannot accept as the grantor patient.
 */
export async function acceptDelegation(ctx: PatientContext, token: string) {
  if (!token || token.length < 16) throw new NotFoundError();
  const inviteTokenHash = hashInviteToken(token);
  const delegation = await prisma.patientDelegation.findUnique({
    where: { inviteTokenHash },
    include: { patient: { select: { userId: true } } },
  });
  // Anti-enumeration: any failure looks identical.
  if (!delegation || delegation.status !== "INVITED") throw new NotFoundError();
  if (delegation.inviteExpiresAt && delegation.inviteExpiresAt.getTime() <= Date.now()) throw new NotFoundError();
  // You cannot become a delegate over a record that is your own.
  if (delegation.patient.userId && delegation.patient.userId === ctx.userId) throw new BadRequestError("This is your own record.");

  const result = await prisma.patientDelegation.updateMany({
    where: { id: delegation.id, status: "INVITED", version: delegation.version },
    data: {
      delegateUserId: ctx.userId,
      status: "ACTIVE",
      acceptedAt: new Date(),
      // Burn the token: it can never be replayed.
      inviteTokenHash: null,
      version: { increment: 1 },
    },
  });
  if (result.count === 0) throw new ConflictError();
  await recordAuditEvent("patient.delegation.accepted", ctx.userId, { delegationId: delegation.id, patientId: delegation.patientId }, { patientId: delegation.patientId });
  return { ok: true as const };
}

/** Revoke a delegation. Only the grantor patient may revoke, and only their own. */
export async function revokeDelegation(scope: PatientAccessScope, actorUserId: string, delegationId: string, reason?: string) {
  if (!scope.isSelf) throw new NotFoundError();
  const delegation = await prisma.patientDelegation.findUnique({ where: { id: delegationId }, select: { patientId: true, status: true, version: true } });
  // Not ours / nonexistent => 404-shaped.
  if (!delegation || delegation.patientId !== scope.patientId) throw new NotFoundError();
  if (["REVOKED", "EXPIRED"].includes(delegation.status)) throw new BadRequestError("This access has already ended.");

  const result = await prisma.patientDelegation.updateMany({
    where: { id: delegationId, status: delegation.status, version: delegation.version },
    data: { status: "REVOKED", revokedAt: new Date(), revokedReason: reason, delegateUserId: delegation.status === "INVITED" ? null : undefined, version: { increment: 1 } },
  });
  if (result.count === 0) throw new ConflictError();
  await recordAuditEvent("patient.delegation.revoked", actorUserId, { delegationId, patientId: scope.patientId, reason: reason ?? null }, { patientId: scope.patientId, facilityId: scope.facilityId });
  return { ok: true as const };
}
