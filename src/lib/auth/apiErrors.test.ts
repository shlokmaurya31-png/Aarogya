import { describe, it, expect } from "vitest";
import { withApiErrors, UnauthorizedError, ForbiddenError, NotFoundError, BadRequestError, ConflictError } from "./rbac";

/**
 * Error classification is a production contract: a client must be able to tell
 * a validation failure from an authorization failure from a lost race, and no
 * database internals may reach the caller (gate §46).
 *
 * The regression pinned here is that a PostgreSQL deadlock — which is how a
 * genuinely concurrent engine reports a lost race — used to fall through to a
 * masked 500, making a retryable conflict look like a server bug.
 */
async function status(fn: () => Promise<unknown>) {
  const res = await withApiErrors(fn);
  return { code: res.status, body: (await res.json()) as { error?: string } };
}

describe("withApiErrors classification", () => {
  it("passes a successful result through as 200", async () => {
    const { code, body } = await status(async () => ({ ok: true }));
    expect(code).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("maps the four canonical domain errors to their own status codes", async () => {
    expect((await status(async () => { throw new UnauthorizedError(); })).code).toBe(401);
    expect((await status(async () => { throw new ForbiddenError("quality:incident:read"); })).code).toBe(403);
    expect((await status(async () => { throw new NotFoundError(); })).code).toBe(404);
    expect((await status(async () => { throw new BadRequestError(); })).code).toBe(400);
    expect((await status(async () => { throw new ConflictError(); })).code).toBe(409);
  });

  it("maps a PostgreSQL deadlock to a retryable 409, not a masked 500", async () => {
    const err = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const { code, body } = await status(async () => { throw err; });
    expect(code).toBe(409);
    expect(body.error).toMatch(/changed concurrently/i);
  });

  it("maps a serialization failure and Prisma's P2034 to 409", async () => {
    for (const code of ["40001", "P2034"]) {
      const err = Object.assign(new Error("could not serialize access due to concurrent update"), { code });
      expect((await status(async () => { throw err; })).code).toBe(409);
    }
  });

  it("maps SQLite's busy-database race to the same 409", async () => {
    const { code } = await status(async () => { throw new Error("database is locked"); });
    expect(code).toBe(409);
  });

  it("never leaks database internals through the concurrency path", async () => {
    const err = Object.assign(new Error('deadlock detected on relation "StaffShift" pid 263'), { code: "40P01" });
    const { body } = await status(async () => { throw err; });
    expect(body.error).not.toMatch(/StaffShift|pid|relation/);
  });

  it("still masks a genuine unexpected fault as 500 without echoing it", async () => {
    const { code, body } = await status(async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432"); });
    expect(code).toBe(500);
    expect(body.error).toBe("Internal error.");
    expect(body.error).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
  });

  it("honours a domain error that carries its own 4xx status", async () => {
    const err = Object.assign(new Error("Required clinical privilege has expired."), { status: 403 });
    const { code, body } = await status(async () => { throw err; });
    expect(code).toBe(403);
    expect(body.error).toMatch(/privilege has expired/);
  });

  it("does not let an attacker-chosen 5xx status escape the fallthrough", async () => {
    const err = Object.assign(new Error("internal detail"), { status: 503 });
    const { code, body } = await status(async () => { throw err; });
    expect(code).toBe(500);
    expect(body.error).toBe("Internal error.");
  });
});
