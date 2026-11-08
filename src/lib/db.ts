import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * A User's passwordHash is never read unless a query asks for it by name
 * (`select: { passwordHash: true }`, or `omit: { passwordHash: false }` in
 * the login route). Flagship 2 found the chart returning staff hashes through
 * `include: { user: true }`; this closes that whole class (and withApiErrors
 * refuses any response that still carries one).
 */
function makeClient() {
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    omit: { user: { passwordHash: true } },
  }) as unknown as PrismaClient;
}

export const prisma = globalForPrisma.prisma ?? makeClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * Options for an interactive transaction whose callers queue on a lock (a
 * per-key pg_advisory_xact_lock). Prisma's defaults (maxWait 2s to start,
 * timeout 5s to finish) turned a momentary stall into a spurious failure: a
 * contender that couldn't start within 2s failed with P2028 instead of waiting
 * its turn (verify:all, appointment race, batch 8). The same budgets the
 * serializable billing transactions use.
 */
export const CONTENDED_TX = { maxWait: 10_000, timeout: 20_000 } as const;
