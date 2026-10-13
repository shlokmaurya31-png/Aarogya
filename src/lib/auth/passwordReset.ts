import { createHash, createHmac, timingSafeEqual } from "crypto";

/**
 * Stateless, single-use password reset tokens.
 *
 * The token is HMAC-signed (AUTH_SECRET, domain-separated from session
 * cookies) and carries a fingerprint of the user's CURRENT password hash.
 * Resetting the password changes the hash, so the token stops verifying:
 * single use without a token table. It also dies if the user changes their
 * password any other way, and it expires after RESET_TTL_MS.
 */

export const RESET_TTL_MS = 30 * 60_000;
export const MIN_PASSWORD_LENGTH = 8;

interface ResetPayload {
  u: string; // user id
  e: number; // expiry, epoch ms
  f: string; // password-hash fingerprint
}

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET is not configured.");
  return s;
}

function sign(payload: string) {
  return createHmac("sha256", secret()).update(`password-reset:${payload}`).digest("base64url");
}

export function passwordFingerprint(passwordHash: string) {
  return createHash("sha256").update(passwordHash).digest("base64url").slice(0, 22);
}

export function createResetToken(user: { id: string; passwordHash: string }, now = Date.now()): string {
  const payload: ResetPayload = { u: user.id, e: now + RESET_TTL_MS, f: passwordFingerprint(user.passwordHash) };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

/** Signature + expiry check only. Returns the claims; the caller must still check the fingerprint. */
export function readResetToken(token: string, now = Date.now()): ResetPayload | null {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const a = Buffer.from(signature);
  const b = Buffer.from(sign(encoded));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ResetPayload;
    if (typeof payload.u !== "string" || typeof payload.f !== "string" || typeof payload.e !== "number") return null;
    if (payload.e < now) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Full check against the user's current password hash. */
export function resetTokenMatches(payload: ResetPayload, currentPasswordHash: string) {
  const a = Buffer.from(payload.f);
  const b = Buffer.from(passwordFingerprint(currentPasswordHash));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function appBaseUrl() {
  return (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
}
