import { NextResponse } from "next/server";
import { getSession, type SessionPayload } from "./session";
import { roleHasPermission, type Permission } from "./permissions";
import { prisma } from "@/lib/db";

export class UnauthorizedError extends Error {
  status = 401 as const;
  constructor() {
    super("Sign in required.");
  }
}

export class ForbiddenError extends Error {
  status = 403 as const;
  constructor(permission: Permission) {
    super(`Missing permission: ${permission}`);
  }
}

export class NotFoundError extends Error {
  status = 404 as const;
  constructor(message = "Not found.") {
    super(message);
  }
}

export class BadRequestError extends Error {
  status = 400 as const;
  constructor(message = "Bad request.") {
    super(message);
  }
}

/**
 * A write lost a genuine concurrency race and is safely retryable by the caller.
 * Distinct from BadRequestError: nothing about the request was invalid, the
 * record simply changed underneath it (Phase B gate §46 — validation,
 * authorization, not-found, conflict and concurrency failures must be
 * distinguishable by clients).
 */
export class ConflictError extends Error {
  status = 409 as const;
  constructor(message = "This record changed concurrently. Refresh and try again.") {
    super(message);
  }
}

/**
 * PostgreSQL reports lost concurrency races as deadlock_detected (40P01) or
 * serialization_failure (40001); Prisma surfaces the latter as P2034. These are
 * NOT server bugs — under real parallel load one transaction is chosen as the
 * victim — so they must map to a retryable 409 rather than a masked 500.
 * SQLite's analogue is SQLITE_BUSY. Detected structurally (no reliance on a
 * Prisma error subclass) so this holds across engines and Prisma versions.
 */
function isRetryableConcurrencyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === "P2034" || code === "40P01" || code === "40001") return true;
  const message = err instanceof Error ? err.message : "";
  return /deadlock detected|could not serialize access|database is locked|SQLITE_BUSY/i.test(message);
}

/** Verifies the session cookie AND that the user still exists. Never trusts client-sent role. */
export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, role: true, tokenVersion: true },
  });
  if (!user) throw new UnauthorizedError();

  // Phase C4 — revocation. Sessions are stateless HMAC cookies, so this
  // comparison IS the revocation check: bumping User.tokenVersion
  // invalidates every cookie previously issued to that user, making
  // logout-all, password change, role change and administrative revoke take
  // effect immediately instead of waiting out a 14-day expiry.
  // A pre-C4 cookie has no `ver` and is read as 0, matching the column
  // default, so existing sessions keep working until something bumps it.
  if ((session.ver ?? 0) !== user.tokenVersion) throw new UnauthorizedError();
  // Defense in depth: re-derive role from the DB, not just the cookie payload.
  return { ...session, role: user.role };
}

export async function requirePermission(permission: Permission): Promise<SessionPayload> {
  const session = await requireSession();
  if (!roleHasPermission(session.role, permission)) {
    throw new ForbiddenError(permission);
  }
  return session;
}

/** Wraps a route handler body, turning UnauthorizedError/ForbiddenError into proper HTTP responses. */
export async function withApiErrors<T>(fn: () => Promise<T>): Promise<NextResponse> {
  try {
    const result = await fn();
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof BadRequestError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    // Phase C4 — a structured authorization denial. Carries its own status
    // (403 / 404-shaped / 401 for step-up) and a decision code so a UI can
    // offer the right next step, while the message stays uninformative about
    // WHY — a cross-facility denial must be indistinguishable from a
    // nonexistent record.
    if (err && typeof err === "object" && (err as { name?: string }).name === "AuthorizationDeniedError") {
      const denial = err as { status: number; message: string; decision: string };
      return NextResponse.json({ error: denial.message, decision: denial.decision }, { status: denial.status });
    }
    if (err instanceof ConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // A lost database-level race is a retryable conflict, not an internal error.
    // Mapped before the generic fallthrough and before the 500, and deliberately
    // reported with a fixed message so no database internals reach the client.
    if (isRetryableConcurrencyError(err)) {
      return NextResponse.json(
        { error: "This record changed concurrently. Refresh and try again." },
        { status: 409 }
      );
    }
    // Generic fallthrough for domain errors that carry an explicit HTTP status
    // (e.g. Phase B10's CredentialAuthorizationError, a 403 that is NOT a
    // missing-RBAC-permission ForbiddenError). Only 4xx client errors are
    // surfaced this way; anything else remains a masked 500.
    if (err && typeof err === "object" && "status" in err) {
      const status = (err as { status?: unknown }).status;
      const message = err instanceof Error ? err.message : "Request failed.";
      if (typeof status === "number" && status >= 400 && status < 500) {
        return NextResponse.json({ error: message }, { status });
      }
    }
    console.error(err);
    return NextResponse.json({ error: "Internal error." }, { status: 500 });
  }
}
