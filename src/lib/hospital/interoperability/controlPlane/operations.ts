import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import type { AuthorizationActor } from "@/lib/auth/authorize/types";
import { isAutoRetryable, normaliseFailureCategory } from "./exchanges";
import { raiseAlert } from "./alerts";
import { describeIntegration, assertKnownSystem } from "./registry";

/**
 * Phase C6 — operator-driven exchange recovery.
 *
 * Manual retry DELEGATES to the protocol module that owns the exchange. This
 * file decides whether a retry is permissible and records that a human asked
 * for it; the actual resend is C3's `retryExchange` or C5's `retryExchange`,
 * each of which already reuses its original idempotency identity. Reimplementing
 * the resend here would create a second path to the outside world with its own
 * duplicate-prevention bugs.
 *
 * A manual retry is still bound by the SAME category rules as an automatic one.
 * An operator cannot retry a CONSENT or AUTHORIZATION refusal by clicking
 * harder — those are not transient conditions, and letting a human override
 * them would turn the retry button into a consent bypass.
 */

export interface RetryEligibility {
  eligible: boolean;
  reason: string | null;
  category: string;
  attemptCount: number;
  maxAttempts: number;
}

export function assessRetryEligibility(row: {
  state: string; category: string | null; attemptCount: number; maxAttempts: number;
}): RetryEligibility {
  const category = normaliseFailureCategory(row.category);
  const base = { category, attemptCount: row.attemptCount, maxAttempts: row.maxAttempts };

  if (row.state !== "FAILED" && row.state !== "REQUIRES_REVIEW") {
    return { ...base, eligible: false, reason: "Only a failed exchange can be retried." };
  }
  if (row.attemptCount >= row.maxAttempts) {
    return { ...base, eligible: false, reason: `This exchange has exhausted its ${row.maxAttempts} attempts.` };
  }
  if (!isAutoRetryable(category)) {
    return {
      ...base, eligible: false,
      reason: `A ${category} failure is not retryable. Resolve the underlying cause and start a new exchange.`,
    };
  }
  return { ...base, eligible: true, reason: null };
}

/**
 * Retry one failed exchange on an operator's instruction.
 *
 * Re-checks the integration's dispatch gate first: an exchange that failed
 * before the integration was disabled must not resend just because somebody
 * still has the failure list open.
 */
export async function manualRetry(input: {
  facilityId: string; source: "ABDM" | "NHCX"; exchangeId: string; actor: AuthorizationActor; reason: string;
}) {
  if (!input.reason?.trim()) throw new BadRequestError("A reason is required to retry an exchange manually.");

  const system = assertKnownSystem(input.source === "NHCX" ? "NHCX" : "ABDM");
  const view = await describeIntegration(input.facilityId, system);
  if (!view.dispatch.allowed) {
    throw new BadRequestError(view.dispatch.reason ?? "This integration cannot dispatch.");
  }

  if (input.source === "NHCX") {
    const ex = await prisma.nhcxExchange.findUnique({ where: { id: input.exchangeId } });
    if (!ex || ex.facilityId !== input.facilityId) throw new NotFoundError("Exchange not found.");

    const eligibility = assessRetryEligibility({
      state: ex.protocolState === "FAILED"
        ? (ex.attemptCount >= ex.maxAttempts ? "REQUIRES_REVIEW" : "FAILED")
        : ex.protocolState,
      category: ex.errorCategory, attemptCount: ex.attemptCount, maxAttempts: ex.maxAttempts,
    });
    if (!eligibility.eligible) throw new BadRequestError(eligibility.reason ?? "Not retryable.");

    const { retryExchange } = await import("@/lib/hospital/nhcx/submission");
    const result = await retryExchange({
      exchangeId: ex.id, facilityId: input.facilityId, actor: input.actor,
    });

    await recordAuditEvent(
      "hospital.interop.exchangeRetried",
      input.actor.userId,
      {
        source: "NHCX", exchangeId: ex.id, correlationId: ex.correlationId,
        category: eligibility.category, reason: input.reason.trim().slice(0, 200),
      },
      { facilityId: input.facilityId }
    );
    return { source: "NHCX" as const, exchange: result };
  }

  const ex = await prisma.healthInformationExchange.findUnique({ where: { id: input.exchangeId } });
  if (!ex || ex.facilityId !== input.facilityId) throw new NotFoundError("Exchange not found.");

  const eligibility = assessRetryEligibility({
    state: ex.status === "FAILED"
      ? (ex.retryCount >= ex.maxRetries ? "REQUIRES_REVIEW" : "FAILED")
      : ex.status,
    category: ex.abdmErrorCode ?? ex.failureReason ?? ex.lastError,
    attemptCount: ex.retryCount, maxAttempts: ex.maxRetries,
  });
  if (!eligibility.eligible) throw new BadRequestError(eligibility.reason ?? "Not retryable.");

  const { retryExchange } = await import("../exchange");
  const result = await retryExchange({
    facilityId: input.facilityId,
    exchangeId: ex.id,
    byUserId: input.actor.userId,
    actorStaffId: input.actor.staffId ?? null,
  });

  await recordAuditEvent(
    "hospital.interop.exchangeRetried",
    input.actor.userId,
    {
      source: "ABDM", exchangeId: ex.id, correlationId: ex.correlationId,
      category: eligibility.category, reason: input.reason.trim().slice(0, 200),
    },
    { facilityId: input.facilityId }
  );
  return { source: "ABDM" as const, exchange: result };
}

/**
 * Detect exchanges that have run out of road and make sure each one is visible.
 *
 * A dead exchange is never discarded: it becomes an operator's problem with an
 * alert attached, because silently dropping a health-information request or a
 * claim submission is how a patient's record or a hospital's money goes missing
 * without anybody noticing.
 */
export async function sweepDeadExchanges(facilityId: string) {
  // Column-to-column comparison is filtered in memory rather than in SQL: raw
  // SQL here would need provider-specific placeholder syntax and would be the
  // one query in this file that behaves differently on SQLite and PostgreSQL.
  const [abdmRows, nhcxRows] = await Promise.all([
    prisma.healthInformationExchange.findMany({
      where: { facilityId, status: "FAILED" },
      select: { id: true, retryCount: true, maxRetries: true },
      take: 1000,
    }),
    prisma.nhcxExchange.findMany({
      where: { facilityId, protocolState: "FAILED" },
      select: { id: true, attemptCount: true, maxAttempts: true },
      take: 1000,
    }),
  ]);
  const abdmDead = abdmRows.filter((r) => r.retryCount >= r.maxRetries);
  const nhcxDead = nhcxRows.filter((r) => r.attemptCount >= r.maxAttempts);

  const total = abdmDead.length + nhcxDead.length;
  if (total > 0) {
    await raiseAlert({
      facilityId,
      system: nhcxDead.length > 0 && abdmDead.length === 0 ? "NHCX" : "ABDM",
      alertType: "RETRY_EXHAUSTED",
      severity: "CRITICAL",
      dedupeKey: "EXCHANGE:RETRY_EXHAUSTED",
      detail:
        `${total} exchange(s) have exhausted their retry budget and require review ` +
        `(${abdmDead.length} ABDM, ${nhcxDead.length} NHCX).`,
    });
  }
  return { abdm: abdmDead.length, nhcx: nhcxDead.length, total };
}

export interface InteroperabilityMetrics {
  facilityId: string;
  bySystem: {
    system: string;
    exchanges: number;
    completed: number;
    failed: number;
    requiresReview: number;
    callbacks: number;
    callbacksRejected: number;
  }[];
  failuresByCategory: { category: string; count: number }[];
  openAlerts: { severity: string; count: number }[];
  /** Exchanges neither completed nor terminally failed. */
  queueDepth: number;
}

/**
 * Structured operational metrics.
 *
 * Counts and categories only. Nothing here reads a bundle, a note, a document
 * or a claim line — an observability surface that can leak a clinical payload
 * is worse than no observability surface.
 */
export async function collectMetrics(facilityId: string): Promise<InteroperabilityMetrics> {
  const [
    abdmByStatus, nhcxByState, abdmCallbacks, nhcxCallbacks, alerts,
  ] = await Promise.all([
    prisma.healthInformationExchange.groupBy({
      by: ["status"], where: { facilityId }, _count: true,
    }),
    prisma.nhcxExchange.groupBy({
      by: ["protocolState"], where: { facilityId }, _count: true,
    }),
    prisma.abdmCallbackEvent.groupBy({ by: ["status"], where: { facilityId }, _count: true }),
    prisma.nhcxCallbackEvent.groupBy({ by: ["status"], where: { facilityId }, _count: true }),
    prisma.integrationAlert.groupBy({
      by: ["severity"], where: { facilityId, status: "OPEN" }, _count: true,
    }),
  ]);

  const countOf = <T extends { _count: number }>(rows: T[], pred: (r: T) => boolean) =>
    rows.filter(pred).reduce((a, r) => a + r._count, 0);

  const abdmTotal = abdmByStatus.reduce((a, r) => a + r._count, 0);
  const nhcxTotal = nhcxByState.reduce((a, r) => a + r._count, 0);

  const [abdmFailures, nhcxFailures] = await Promise.all([
    prisma.healthInformationExchange.findMany({
      where: { facilityId, status: "FAILED" },
      select: { abdmErrorCode: true, failureReason: true, lastError: true },
      take: 500,
    }),
    prisma.nhcxExchange.groupBy({
      by: ["errorCategory"], where: { facilityId, protocolState: "FAILED" }, _count: true,
    }),
  ]);

  const categoryCounts = new Map<string, number>();
  for (const f of abdmFailures) {
    const c = normaliseFailureCategory(f.abdmErrorCode ?? f.failureReason ?? f.lastError);
    categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + 1);
  }
  for (const f of nhcxFailures) {
    const c = normaliseFailureCategory(f.errorCategory);
    categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + f._count);
  }

  const abdmDead = await prisma.healthInformationExchange.count({
    where: { facilityId, status: "FAILED", retryCount: { gte: 3 } },
  });
  const nhcxDead = await prisma.nhcxExchange.count({
    where: { facilityId, protocolState: "FAILED", attemptCount: { gte: 3 } },
  });

  return {
    facilityId,
    bySystem: [
      {
        system: "ABDM",
        exchanges: abdmTotal,
        completed: countOf(abdmByStatus, (r) => r.status === "COMPLETED"),
        failed: countOf(abdmByStatus, (r) => r.status === "FAILED"),
        requiresReview: abdmDead,
        callbacks: abdmCallbacks.reduce((a, r) => a + r._count, 0),
        callbacksRejected: countOf(abdmCallbacks, (r) => r.status !== "ACCEPTED"),
      },
      {
        system: "NHCX",
        exchanges: nhcxTotal,
        completed: countOf(nhcxByState, (r) => r.protocolState === "RESPONDED"),
        failed: countOf(nhcxByState, (r) => r.protocolState === "FAILED"),
        requiresReview: nhcxDead,
        callbacks: nhcxCallbacks.reduce((a, r) => a + r._count, 0),
        callbacksRejected: countOf(nhcxCallbacks, (r) => r.status !== "ACCEPTED"),
      },
    ],
    failuresByCategory: [...categoryCounts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
    openAlerts: alerts.map((a) => ({ severity: a.severity, count: a._count })),
    queueDepth:
      countOf(abdmByStatus, (r) => ["REQUESTED", "AUTHORIZED", "PROCESSING"].includes(r.status)) +
      countOf(nhcxByState, (r) => ["NOT_SUBMITTED", "SUBMITTED", "ACKNOWLEDGED"].includes(r.protocolState)),
  };
}

/**
 * Re-derive alerts from current operational state. Deterministic: the same
 * database state always produces the same alerts.
 */
export async function sweepOperationalAlerts(facilityId: string) {
  const { INTEGRATION_SYSTEMS } = await import("./registry");
  const raised: string[] = [];

  for (const system of INTEGRATION_SYSTEMS) {
    const view = await describeIntegration(facilityId, system);

    // Configured-but-incomplete is an operator problem worth surfacing; a
    // DISABLED integration is not, because nothing is expected of it.
    if (view.connection.environment !== "DISABLED" && view.readiness.dimensions.configuration === "FAIL") {
      await raiseAlert({
        facilityId, system, connectionId: view.connection.id,
        alertType: "CONFIGURATION_MISSING", severity: "WARNING",
        dedupeKey: `${system}:CONFIGURATION_MISSING`,
        detail: view.readiness.blockers.join(" ") || "Required configuration is missing.",
      });
      raised.push(`${system}:CONFIGURATION_MISSING`);
    }

    const runtime = view.runtime as { warnings?: string[] };
    if (Array.isArray(runtime.warnings) && runtime.warnings.some((w) => /production|unsafe/i.test(w))) {
      await raiseAlert({
        facilityId, system, connectionId: view.connection.id,
        alertType: "UNSAFE_ENVIRONMENT", severity: "CRITICAL",
        dedupeKey: `${system}:UNSAFE_ENVIRONMENT`,
        detail: runtime.warnings.find((w) => /production|unsafe/i.test(w)) ?? "Unsafe environment configuration.",
      });
      raised.push(`${system}:UNSAFE_ENVIRONMENT`);
    }
  }

  const dead = await sweepDeadExchanges(facilityId);
  if (dead.total > 0) raised.push("EXCHANGE:RETRY_EXHAUSTED");

  return { raised, dead };
}
