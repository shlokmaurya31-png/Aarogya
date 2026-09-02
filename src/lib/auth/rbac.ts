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

/** Verifies the session cookie AND that the user still exists. Never trusts client-sent role. */
export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, role: true } });
  if (!user) throw new UnauthorizedError();
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
    console.error(err);
    return NextResponse.json({ error: "Internal error." }, { status: 500 });
  }
}
