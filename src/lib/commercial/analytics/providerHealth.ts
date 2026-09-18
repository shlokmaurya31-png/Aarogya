import type { BillingProviderKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { type ActorMemberships } from "@/lib/auth/tenantContext";
import { requirePlatform } from "@/lib/billing/authz";
import { isProviderConfigured, configuredProviderKind } from "@/lib/billing/provider";

/**
 * Phase D5 — provider operational health.
 *
 * Health is derived ONLY from actual server-side configuration presence and real
 * recorded activity (webhook + reconciliation rows). It NEVER makes a provider
 * call to populate a dashboard, NEVER fabricates uptime/transaction counts, and
 * shows RAZORPAY as NOT_CONFIGURED when credentials are absent (as they are here).
 */

export type ProviderHealthState = "NOT_CONFIGURED" | "CONFIGURED" | "DEGRADED" | "ERROR" | "DISABLED";

const REPORTED_PROVIDERS: BillingProviderKind[] = ["RAZORPAY", "FAKE"];

async function healthFor(kind: BillingProviderKind) {
  const configured = isProviderConfigured(kind);
  const [webhookRows, openExceptions, lastProcessed, lastRejected] = await Promise.all([
    prisma.billingWebhookEvent.groupBy({ by: ["status"], where: { providerKind: kind }, _count: true }),
    prisma.billingReconciliationException.count({ where: { providerKind: kind, resolved: false } }),
    prisma.billingWebhookEvent.findFirst({ where: { providerKind: kind, status: "PROCESSED" }, orderBy: { processedAt: "desc" }, select: { processedAt: true } }),
    prisma.billingWebhookEvent.findFirst({ where: { providerKind: kind, status: "REJECTED" }, orderBy: { receivedAt: "desc" }, select: { receivedAt: true } }),
  ]);
  const webhooks: Record<string, number> = {};
  for (const r of webhookRows) webhooks[r.status] = r._count;

  let state: ProviderHealthState;
  if (!configured) state = "NOT_CONFIGURED";
  else if ((webhooks.REJECTED ?? 0) > 0 || (webhooks.FAILED ?? 0) > 0) state = "ERROR";
  else if (openExceptions > 0) state = "DEGRADED";
  else state = "CONFIGURED";

  return {
    provider: kind,
    configured,
    state,
    selected: configuredProviderKind() === kind,
    webhooks,
    openReconciliationExceptions: openExceptions,
    lastSuccessfulInteraction: lastProcessed?.processedAt ?? null,
    lastFailedInteraction: lastRejected?.receivedAt ?? null,
  };
}

export async function getProviderHealth(m: ActorMemberships) {
  requirePlatform(m);
  const providers = await Promise.all(REPORTED_PROVIDERS.map(healthFor));
  return {
    selectedProvider: configuredProviderKind(),
    note: "Health is derived from configuration presence and recorded activity only; no live provider call is made.",
    providers,
  };
}
