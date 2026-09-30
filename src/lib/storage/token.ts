/**
 * Phase 1.1 — short-lived download tokens for the local-disk adapter.
 *
 * The local adapter cannot mint a provider-native presigned URL, so a download
 * is authorised by an HMAC-signed capability token instead: it names exactly one
 * storageRef and an expiry, signed with AUTH_SECRET. /api/storage/download
 * verifies it (constant-time) before streaming the object. The token is the
 * capability; it is issued only from an authenticated, authorised, audited code
 * path, and it expires quickly.
 */
import { createHmac, timingSafeEqual } from "crypto";

const MIN_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 60 * 15; // 15 minutes — short-lived by policy.
export const DEFAULT_TTL_SECONDS = 60 * 5;

function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is not configured; storage download tokens cannot be signed.");
  }
  return secret;
}

export function clampTtl(seconds: number | undefined): number {
  if (!seconds || !Number.isFinite(seconds)) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(seconds)));
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

/** Produce `<b64url(ref)>.<expEpochMs>.<sig>`. */
export function createDownloadToken(storageRef: string, ttlSeconds?: number): { token: string; expiresAt: Date } {
  const ttl = clampTtl(ttlSeconds);
  const exp = Date.now() + ttl * 1000;
  const encodedRef = Buffer.from(storageRef, "utf8").toString("base64url");
  const body = `${encodedRef}.${exp}`;
  return { token: `${body}.${sign(body)}`, expiresAt: new Date(exp) };
}

/** Verify a token and return the storageRef it authorises, or null if invalid/expired. */
export function verifyDownloadToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedRef, expStr, sig] = parts;
  const body = `${encodedRef}.${expStr}`;
  const expected = sign(body);

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;

  try {
    return Buffer.from(encodedRef, "base64url").toString("utf8");
  } catch {
    return null;
  }
}
