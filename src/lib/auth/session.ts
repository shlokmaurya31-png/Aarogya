import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import type { Role } from "@prisma/client";

/**
 * Aarogya Scholar sessions are an httpOnly, HMAC-signed cookie — not a JWT
 * library, not a third-party session store. The payload is small and the
 * signature is verified server-side on every request; the browser can read
 * neither the role nor the signing key. Rotating AUTH_SECRET invalidates
 * every session at once (coarse revocation, acceptable for v1 — see
 * docs/STUDENT_PLATFORM_ARCHITECTURE.md §2.2 for the production follow-up).
 */

const COOKIE_NAME = "aarogya_scholar_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

export interface SessionPayload {
  userId: string;
  role: Role;
  exp: number;
  /**
   * Phase C4 — revocation. Sessions are stateless HMAC cookies with no
   * server record, so this counter IS the revocation mechanism:
   * requireSession compares it against User.tokenVersion and refuses a
   * mismatch. Bumping the version invalidates every cookie ever issued to
   * that user, which is what makes logout-all, password change, role change
   * and admin revoke take effect without a session table that grows without
   * bound. Optional so pre-C4 cookies still decode (treated as 0).
   */
  ver?: number;
  /** Issued-at, feeding step-up auth. Absent means "cannot tell" = too old. */
  iat?: number;
}

function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_SECRET is not configured. Set it in .env (see .env.example) before using Aarogya Scholar auth."
    );
  }
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

function encode(session: SessionPayload): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

function decode(token: string): SessionPayload | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SessionPayload;
    if (typeof session.exp !== "number" || session.exp < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

export async function createSession(userId: string, role: Role) {
  const session: SessionPayload = { userId, role, exp: Date.now() + SESSION_TTL_MS };
  const store = await cookies();
  store.set(COOKIE_NAME, encode(session), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroySession() {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

/** Reads and verifies the session cookie. Returns null if absent/invalid/expired. */
export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return decode(token);
}

/**
 * Age of the session's authentication, in milliseconds.
 *
 * Returns null when the cookie predates C4 and carries no `iat`. Callers MUST
 * treat null as "too old" — the step-up check in the authorization engine does
 * exactly that, because an unknown authentication age is not evidence of a
 * recent one.
 */
export function sessionAuthAgeMs(session: SessionPayload, now = Date.now()): number | null {
  if (typeof session.iat !== "number") return null;
  return Math.max(0, now - session.iat);
}
