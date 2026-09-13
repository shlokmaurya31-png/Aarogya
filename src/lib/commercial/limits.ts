import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { evaluateEntitlement, resolveLimit } from "./evaluator";

/**
 * Phase D2 — commercial gates that are ENFORCED server-side.
 *
 * A denied entitlement is a 403 (the plan does not include it, or commercial
 * state disables it). A lost concurrency race under Serializable isolation
 * surfaces as the existing retryable 409 (see withApiErrors) — not as an
 * over-limit success.
 */

export class EntitlementDeniedError extends Error {
  readonly status = 403 as const;
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "EntitlementDeniedError";
    this.reason = reason;
  }
}

export class LimitExceededError extends Error {
  readonly status = 403 as const;
  constructor(message: string) {
    super(message);
    this.name = "LimitExceededError";
  }
}

/**
 * Require a BOOLEAN capability for a server-resolved tenant. Throws 403 if the
 * plan does not include it or commercial state disables it. This is a SEPARATE
 * layer from authorization — call it AFTER the C4/D1 checks, never instead.
 */
export async function requireEntitlement(args: { organizationId: string; facilityId?: string | null; key: string }): Promise<void> {
  const r = await evaluateEntitlement(args);
  if (!r.allowed) {
    throw new EntitlementDeniedError(
      `This capability (${args.key}) is not available on the current subscription.`,
      r.reason ?? "NOT_ENTITLED"
    );
  }
}

/**
 * Enforce a LIMIT entitlement while creating a row, race-safe.
 *
 * Runs the count-then-create in a SERIALIZABLE transaction so two concurrent
 * creations for the same organization cannot both pass a limit of N when the
 * count is N-1. On PostgreSQL the loser aborts with serialization_failure
 * (mapped to a retryable 409); on SQLite writers serialise so the second sees
 * the committed count and is denied. Either way exactly one succeeds.
 *
 * `count` and `create` receive the transaction client so the count's predicate
 * and the insert are in the same transaction (required for SSI to detect the
 * conflict).
 */
export async function enforceLimit<T>(args: {
  organizationId: string;
  key: string;
  actorUserId: string | null;
  count: (tx: Prisma.TransactionClient) => Promise<number>;
  create: (tx: Prisma.TransactionClient) => Promise<T>;
  adding?: number;
}): Promise<T> {
  const adding = args.adding ?? 1;
  try {
    return await prisma.$transaction(async (tx) => {
      const { limit, unlimited, commercialActive } = await resolveLimit({ organizationId: args.organizationId, key: args.key });
      if (!commercialActive) {
        throw new EntitlementDeniedError("The organization's subscription is not active.", "COMMERCIAL_INACTIVE");
      }
      if (!unlimited && limit !== null) {
        const n = await args.count(tx);
        if (n + adding > limit) {
          throw new LimitExceededError(`Plan limit reached for ${args.key} (limit ${limit}).`);
        }
      }
      return await args.create(tx);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (err) {
    if (err instanceof LimitExceededError || err instanceof EntitlementDeniedError) {
      await recordAuditEvent("commercial.limit.denied", args.actorUserId, {
        key: args.key, reason: err instanceof LimitExceededError ? "LIMIT_REACHED" : (err as EntitlementDeniedError).reason,
      }, { organizationId: args.organizationId });
    }
    throw err;
  }
}
