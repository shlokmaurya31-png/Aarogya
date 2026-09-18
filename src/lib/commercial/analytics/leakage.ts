import type { BillingReconciliationKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { type ActorMemberships } from "@/lib/auth/tenantContext";
import { requirePlatform } from "@/lib/billing/authz";
import { resolveCurrentPrice } from "@/lib/billing/pricing";

/**
 * Phase D5 — deterministic revenue-leakage detection.
 *
 * Detects where canonical commercial records are internally inconsistent and
 * records a FINDING (a BillingReconciliationException with source="LEAKAGE").
 * It NEVER mutates financial data — detection only. Findings are idempotent:
 * de-duplicated per (kind, entityId) while unresolved. Platform-only.
 */

async function createFinding(input: { kind: BillingReconciliationKind; organizationId: string | null; entityType: string; entityId: string; severity: string; description: string; actorUserId: string | null }) {
  // Race-safe de-duplication: findingKey is UNIQUE while a finding is OPEN. Two
  // concurrent detection runs both attempt the insert; exactly one succeeds and
  // the other hits the unique constraint (P2002) and is skipped — no duplicate.
  const findingKey = `LEAKAGE:${input.kind}:${input.entityId}`;
  try {
    // Create the finding and emit ReconciliationExceptionCreated in one transaction
    // so the domain fact is durable iff the finding committed. A P2002 (dedupe hit)
    // aborts the transaction and is caught below — no event, no finding.
    await prisma.$transaction(async (tx) => {
      const created = await tx.billingReconciliationException.create({
        data: {
          source: "LEAKAGE", kind: input.kind, organizationId: input.organizationId, entityType: input.entityType,
          entityId: input.entityId, severity: input.severity, description: input.description, status: "OPEN", localRef: input.entityId, findingKey,
        },
      });
      // ReconciliationExceptionCreated is organization-scoped; a finding with no
      // organization (rare) is still recorded but emits no tenant-scoped event.
      if (input.organizationId) {
        await emitDomainEvent(tx, {
          type: "ReconciliationExceptionCreated",
          aggregateId: created.id,
          organizationId: input.organizationId,
          actorUserId: input.actorUserId,
          payload: { exceptionId: created.id, kind: input.kind, severity: input.severity, source: "LEAKAGE" },
        });
      }
    });
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return { created: false };
    throw err;
  }
  await recordAuditEvent("commercial.leakage.findingCreated", input.actorUserId, { kind: input.kind, entityId: input.entityId, severity: input.severity }, { organizationId: input.organizationId ?? undefined });
  return { created: true };
}

export async function runLeakageDetection(m: ActorMemberships, opts?: { now?: Date }): Promise<{ scanned: number; created: number }> {
  requirePlatform(m);
  const now = opts?.now ?? new Date();
  let created = 0, scanned = 0;
  const bump = async (r: Promise<{ created: boolean }>) => { if ((await r).created) created++; };

  // 1. ORPHAN_PAYMENT — a payment applied to a VOID invoice.
  const paidVoids = await prisma.billingPayment.findMany({ where: { invoice: { status: "VOID" } }, select: { id: true, organizationId: true, invoiceId: true } });
  scanned += paidVoids.length;
  for (const p of paidVoids) await bump(createFinding({ kind: "ORPHAN_PAYMENT", organizationId: p.organizationId, entityType: "payment", entityId: p.id, severity: "CRITICAL", description: `Payment applied to a VOID invoice ${p.invoiceId}.`, actorUserId: m.userId }));

  // 2. Over-application invariant — amountPaid should never exceed total.
  const overpaid = await prisma.billingInvoice.findMany({ where: { amountPaidMinor: { gt: 0 } }, select: { id: true, organizationId: true, totalMinor: true, amountPaidMinor: true } });
  scanned += overpaid.length;
  for (const inv of overpaid) if (inv.amountPaidMinor > inv.totalMinor) await bump(createFinding({ kind: "STATE_MISMATCH", organizationId: inv.organizationId, entityType: "invoice", entityId: inv.id, severity: "CRITICAL", description: `Invoice amountPaid ${inv.amountPaidMinor} exceeds total ${inv.totalMinor}.`, actorUserId: m.userId }));

  // 3. COMMERCIAL_STATE_MISMATCH — ACTIVE subscription with an overdue unpaid invoice (dunning lag).
  const activeSubs = await prisma.organizationSubscription.findMany({ where: { status: "ACTIVE" }, select: { organizationId: true } });
  for (const s of activeSubs) {
    const overdue = await prisma.billingInvoice.findFirst({ where: { organizationId: s.organizationId, status: { in: ["OPEN", "PARTIALLY_PAID", "PAST_DUE"] }, dueAt: { lt: now } }, select: { id: true } });
    scanned++;
    if (overdue) await bump(createFinding({ kind: "COMMERCIAL_STATE_MISMATCH", organizationId: s.organizationId, entityType: "subscription", entityId: s.organizationId, severity: "MEDIUM", description: "Subscription is ACTIVE but has an overdue unpaid invoice (dunning has not advanced it).", actorUserId: m.userId }));
  }

  // 4. MISSING_INVOICE — a billable subscription past its period end with no newer billing period (missed renewal).
  const lapsed = await prisma.organizationSubscription.findMany({
    where: { status: { in: ["ACTIVE", "PAST_DUE", "GRACE"] }, currentPeriodEnd: { lt: now, not: null }, billingInterval: { not: "NONE" } },
    select: { id: true, organizationId: true, planId: true, billingInterval: true, currentPeriodEnd: true },
  });
  for (const s of lapsed) {
    scanned++;
    const price = await resolveCurrentPrice(prisma, s.planId, s.billingInterval, now);
    if (!price) continue; // not billable
    const newerPeriod = await prisma.billingPeriod.findFirst({ where: { subscriptionId: s.id, periodStart: { gte: s.currentPeriodEnd! } }, select: { id: true } });
    if (!newerPeriod) await bump(createFinding({ kind: "MISSING_INVOICE", organizationId: s.organizationId, entityType: "subscription", entityId: s.id, severity: "HIGH", description: "Billable subscription is past its period end with no renewal invoice for the new period.", actorUserId: m.userId }));
  }

  return { scanned, created };
}
