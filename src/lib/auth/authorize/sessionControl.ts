import { prisma } from "@/lib/db";
import { NotFoundError } from "../rbac";
import { recordAuditEvent } from "../audit";

/**
 * Phase C4 — session revocation and the step-up / MFA abstraction.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY A COUNTER AND NOT A SESSION TABLE
 *
 * Aarogya sessions are stateless HMAC-signed cookies. That design is good — no
 * server lookup on every request, no session store to lose — but it has one
 * genuine weakness: an issued cookie is valid until it expires, and there is no
 * way to take it back.
 *
 * `User.tokenVersion` fixes that with the smallest possible change. Every
 * cookie carries the version it was minted at; `requireSession` refuses a
 * mismatch. Bumping the counter therefore invalidates every cookie that user
 * holds, instantly.
 *
 * That covers the revocations that actually matter: logout, password change,
 * role change, staff deactivation, administrative revoke, suspected compromise.
 *
 * What it deliberately does NOT cover is revoking ONE device while leaving
 * others signed in. That needs per-session state, which means an unbounded
 * table, and the value did not justify it here. It is recorded as a known
 * limitation rather than quietly implied.
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * Revoke every session for a user by bumping their token version.
 *
 * Returns the new version. Idempotent in effect: calling it twice simply
 * invalidates twice.
 */
export async function revokeAllSessions(input: {
  userId: string;
  /** Who performed the revocation. Server-derived by the caller. */
  byUserId: string;
  reason: string;
  facilityId?: string | null;
}) {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, tokenVersion: true },
  });
  if (!user) throw new NotFoundError("User not found.");

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { tokenVersion: { increment: 1 } },
    select: { tokenVersion: true },
  });

  await recordAuditEvent(
    "security.session.allRevoked",
    input.byUserId,
    {
      targetUserId: input.userId,
      reason: input.reason,
      newTokenVersion: updated.tokenVersion,
      // Self-revocation (logout everywhere) and administrative revocation are
      // materially different events; recording which it was matters.
      selfInitiated: input.byUserId === input.userId,
    },
    { facilityId: input.facilityId ?? undefined }
  );
  return { tokenVersion: updated.tokenVersion };
}

/**
 * Invalidate sessions after a credential change.
 *
 * Called on password change. A password change that leaves old sessions alive
 * gives a false sense of having locked an attacker out, which is worse than not
 * offering the feature.
 */
export async function invalidateSessionsOnCredentialChange(userId: string) {
  return revokeAllSessions({
    userId, byUserId: userId, reason: "Credentials changed.",
  });
}

/** Current token version, for minting a cookie at login. */
export async function currentTokenVersion(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { tokenVersion: true } });
  return user?.tokenVersion ?? 0;
}

// ── Step-up authentication / MFA ────────────────────────────────────────────

/**
 * MFA provider states.
 *
 * There is no MFA provider in this deployment. The abstraction exists so that
 * step-up policy can be written and tested now, and a real provider can be
 * attached later without touching the authorization engine.
 *
 * CRITICAL: `VERIFIED` is never returned by the unconfigured provider. A mock
 * that reports success would make every step-up policy in the system a lie.
 */
export type MfaState =
  | "NOT_CONFIGURED"
  | "CONFIGURED"
  | "CHALLENGE_REQUIRED"
  | "VERIFIED"
  | "FAILED";

export interface MfaProvider {
  readonly name: string;
  status(userId: string): Promise<{ state: MfaState; message: string }>;
  challenge(userId: string): Promise<{ state: MfaState; message: string }>;
  verify(userId: string, response: string): Promise<{ state: MfaState; message: string }>;
}

/**
 * The only provider that exists. Every method reports NOT_CONFIGURED, and none
 * of them can return VERIFIED.
 *
 * Step-up therefore currently falls back to authentication RECENCY — the
 * session's `iat` — which is a real, enforceable control rather than a
 * pretend one. When a provider is attached, the engine's step-up branch is
 * where it plugs in.
 */
export const unconfiguredMfaProvider: MfaProvider = {
  name: "none",
  async status() {
    return {
      state: "NOT_CONFIGURED",
      message: "No MFA provider is configured for this deployment.",
    };
  },
  async challenge() {
    return {
      state: "NOT_CONFIGURED",
      message: "No MFA provider is configured; a challenge cannot be issued.",
    };
  },
  async verify() {
    return {
      state: "NOT_CONFIGURED",
      message: "No MFA provider is configured; nothing can be verified.",
    };
  },
};

export function getMfaProvider(): MfaProvider {
  // Deliberately no environment switch: there is nothing to switch to, and a
  // config flag would imply otherwise.
  return unconfiguredMfaProvider;
}

/**
 * Describe step-up capability for the security dashboard.
 *
 * Reports honestly that the enforced mechanism is re-authentication recency,
 * not MFA, so nobody reads the UI as "MFA is on".
 */
export async function describeStepUp(userId: string) {
  const provider = getMfaProvider();
  const status = await provider.status(userId);
  return {
    mfaProvider: provider.name,
    mfaState: status.state,
    mfaMessage: status.message,
    enforcedMechanism: "AUTHENTICATION_RECENCY",
    note:
      "Sensitive actions require a recently authenticated session. This is not MFA. " +
      "No multi-factor provider is configured, and no action reports MFA as verified.",
  };
}
