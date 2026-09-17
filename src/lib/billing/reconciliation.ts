import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { type ActorMemberships } from "@/lib/auth/tenantContext";
import { requirePlatform } from "./authz";
import { getProvider } from "./provider";

/**
 * Phase D3 — lightweight reconciliation boundary (NOT a finance analytics engine).
 *
 * Detects, and records as exceptions, the divergences that matter: an Aarogya
 * payment whose provider state disagrees (STATE_MISMATCH), a payment attempt
 * stuck pending (STUCK_PAYMENT), and a refund total that exceeds its payment
 * (REFUND_MISMATCH — an invariant that should never occur, surfaced if it ever
 * does). Unknown provider references are flagged by the webhook pipeline. The goal
 * is "no silent financial divergence", nothing larger. Platform-only.
 */

const STUCK_ATTEMPT_MS = 60 * 60 * 1000; // 1 hour

async function flag(kind: "STATE_MISMATCH" | "STUCK_PAYMENT" | "REFUND_MISMATCH" | "MISSING_PROVIDER_PAYMENT", opts: { organizationId?: string | null; providerKind?: "NONE" | "FAKE"; providerRef?: string | null; detail?: Record<string, unknown> }) {
  // De-duplicate: one open exception per (kind, providerRef).
  const existing = await prisma.billingReconciliationException.findFirst({
    where: { kind, providerRef: opts.providerRef ?? null, resolved: false },
  });
  if (existing) return existing;
  const row = await prisma.billingReconciliationException.create({
    data: {
      kind, organizationId: opts.organizationId ?? null, providerKind: opts.providerKind ?? "NONE",
      providerRef: opts.providerRef ?? null, detail: opts.detail ? JSON.parse(JSON.stringify(opts.detail)) : undefined,
    },
  });
  await recordAuditEvent("commercial.billing.reconciliationFlagged", null, { kind, providerRef: opts.providerRef ?? null }, { organizationId: opts.organizationId ?? undefined });
  return row;
}

/** Scan for divergences (optionally scoped to one organization). Platform-only. */
export async function runReconciliation(m: ActorMemberships, organizationId?: string): Promise<{ scanned: number; flagged: number }> {
  requirePlatform(m);
  const now = Date.now();
  let flagged = 0;

  // 1. Payment vs provider state (only for payments with a real/fake provider ref).
  const payments = await prisma.billingPayment.findMany({
    where: { ...(organizationId ? { organizationId } : {}), providerKind: { not: "NONE" }, providerPaymentRef: { not: null } },
    select: { id: true, organizationId: true, providerKind: true, providerPaymentRef: true, status: true, amountMinor: true, refundedMinor: true },
  });
  for (const p of payments) {
    // REFUND_MISMATCH invariant check (guarded elsewhere; surfaced if ever violated).
    if (p.refundedMinor > p.amountMinor) {
      await flag("REFUND_MISMATCH", { organizationId: p.organizationId, providerKind: p.providerKind as "FAKE", providerRef: p.providerPaymentRef, detail: { refundedMinor: p.refundedMinor, amountMinor: p.amountMinor } });
      flagged++;
    }
    try {
      const provider = getProvider(p.providerKind);
      const remote = await provider.retrievePayment(p.providerPaymentRef!);
      const localSucceeded = p.status === "SUCCEEDED" || p.status === "PARTIALLY_REFUNDED" || p.status === "REFUNDED";
      if (!remote) {
        await flag("MISSING_PROVIDER_PAYMENT", { organizationId: p.organizationId, providerKind: p.providerKind as "FAKE", providerRef: p.providerPaymentRef, detail: { localStatus: p.status } });
        flagged++;
      } else if (localSucceeded && remote.status !== "succeeded") {
        await flag("STATE_MISMATCH", { organizationId: p.organizationId, providerKind: p.providerKind as "FAKE", providerRef: p.providerPaymentRef, detail: { localStatus: p.status, remoteStatus: remote.status } });
        flagged++;
      }
    } catch { /* no provider configured for this kind — skip */ }
  }

  // 2. Stuck attempts.
  const stuck = await prisma.billingPaymentAttempt.findMany({
    where: { ...(organizationId ? { organizationId } : {}), status: { in: ["INITIATED", "PENDING"] }, createdAt: { lt: new Date(now - STUCK_ATTEMPT_MS) } },
    select: { id: true, organizationId: true, providerPaymentRef: true },
  });
  for (const a of stuck) {
    await flag("STUCK_PAYMENT", { organizationId: a.organizationId, providerRef: a.providerPaymentRef ?? a.id, detail: { attemptId: a.id } });
    flagged++;
  }

  return { scanned: payments.length + stuck.length, flagged };
}

export async function listReconciliationExceptions(m: ActorMemberships, opts?: { resolved?: boolean }) {
  requirePlatform(m);
  return prisma.billingReconciliationException.findMany({
    where: { resolved: opts?.resolved ?? false },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

export async function resolveException(m: ActorMemberships, id: string) {
  requirePlatform(m);
  const ex = await prisma.billingReconciliationException.findUnique({ where: { id } });
  if (!ex) throw new NotFoundError();
  const updated = await prisma.billingReconciliationException.update({ where: { id }, data: { resolved: true, resolvedAt: new Date() } });
  await recordAuditEvent("commercial.billing.reconciliationResolved", m.userId, { id, kind: ex.kind }, { organizationId: ex.organizationId ?? undefined });
  return updated;
}
