import { prisma } from "@/lib/db";
import { assertOrganizationAccess, type ActorMemberships } from "@/lib/auth/tenantContext";
import { requirePlatform } from "@/lib/billing/authz";
import { resolvePeriod, safeRate } from "./shared";

/**
 * Phase D5 — payment failure intelligence.
 *
 * Failure categories are derived ONLY from the failure classification the
 * provider/domain actually recorded (attempt.failureCode). We never assert a
 * specific cause (e.g. insufficient funds) unless the code literally indicates
 * it; anything unrecognized is UNKNOWN_PROVIDER_ERROR. Never exposes secrets.
 */

export type FailureCategory =
  | "CONFIGURATION_ERROR" | "AUTHENTICATION_FAILURE" | "CUSTOMER_ACTION_REQUIRED"
  | "PROVIDER_DECLINE" | "INSUFFICIENT_FUNDS" | "NETWORK_ERROR" | "RATE_LIMIT"
  | "TIMEOUT" | "UNKNOWN_PROVIDER_ERROR";

export function categorizeFailure(code: string | null | undefined): FailureCategory {
  const c = (code ?? "").toLowerCase();
  if (!c) return "UNKNOWN_PROVIDER_ERROR";
  if (c.includes("insufficient")) return "INSUFFICIENT_FUNDS";
  // Customer-action reasons (3DS/OTP/authentication_required) must be checked
  // BEFORE the generic "auth" rule so they are not mislabelled as auth failures.
  if (c.includes("action") || c.includes("3ds") || c.includes("otp") || c.includes("authentication_required")) return "CUSTOMER_ACTION_REQUIRED";
  if (c.includes("declin") || c.includes("card_declined")) return "PROVIDER_DECLINE";
  if (c.includes("auth")) return "AUTHENTICATION_FAILURE";
  if (c.includes("timeout")) return "TIMEOUT";
  if (c.includes("network") || c.includes("gateway_error") || c.includes("server_error")) return "NETWORK_ERROR";
  if (c.includes("rate") || c.includes("429")) return "RATE_LIMIT";
  if (c.includes("config") || c.includes("bad_request")) return "CONFIGURATION_ERROR";
  return "UNKNOWN_PROVIDER_ERROR";
}

export async function getPaymentFailureAnalytics(m: ActorMemberships, opts?: { fromISO?: string; toISO?: string; organizationId?: string }) {
  if (opts?.organizationId) assertOrganizationAccess(m, opts.organizationId);
  else requirePlatform(m);
  const period = resolvePeriod(opts?.fromISO, opts?.toISO);
  const scope = opts?.organizationId ? { organizationId: opts.organizationId } : {};

  const [failed, succeeded] = await Promise.all([
    prisma.billingPaymentAttempt.findMany({
      where: { ...scope, status: "FAILED", createdAt: { gte: period.from, lt: period.to } },
      select: { id: true, organizationId: true, invoiceId: true, failureCode: true, failureReason: true, providerKind: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.billingPaymentAttempt.count({ where: { ...scope, status: "SUCCEEDED", createdAt: { gte: period.from, lt: period.to } } }),
  ]);

  const categories: Record<string, number> = {};
  const orgs = new Set<string>(); const invoices = new Set<string>();
  for (const f of failed) {
    categories[categorizeFailure(f.failureCode)] = (categories[categorizeFailure(f.failureCode)] ?? 0) + 1;
    orgs.add(f.organizationId); invoices.add(f.invoiceId);
  }
  const total = failed.length + succeeded;

  return {
    period: { from: period.from, to: period.to, days: period.days, timezone: "UTC" },
    failedCount: failed.length,
    succeededCount: succeeded,
    failureRate: safeRate(failed.length, total),
    categories,
    organizationsAffected: orgs.size,
    invoicesAffected: invoices.size,
    recentFailures: failed.slice(0, 20).map((f) => ({
      attemptId: f.id, organizationId: f.organizationId, invoiceId: f.invoiceId,
      category: categorizeFailure(f.failureCode), providerKind: f.providerKind, at: f.createdAt,
    })),
  };
}
