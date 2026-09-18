import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { assertOrganizationAccess, type ActorMemberships } from "@/lib/auth/tenantContext";
import { requirePlatform } from "@/lib/billing/authz";
import { invoiceOutstandingMinor, OPEN_INVOICE_STATES, CurrencyBuckets } from "./shared";

/**
 * Phase D5 — collections operational layer.
 *
 * Collection STATE is DERIVED from canonical commercial state + overdue invoices;
 * it is never a client-set field. Manual collection notes are explicit
 * CollectionActivity records that NEVER mutate invoices/payments. Any real
 * financial adjustment still goes through the authorized credit/adjustment path.
 */

export type CollectionState = "NORMAL" | "ATTENTION" | "PAST_DUE" | "GRACE" | "SUSPENSION_RISK" | "SUSPENDED";

const SUSPENSION_RISK_WINDOW_MS = 3 * 86_400_000;

export function deriveCollectionState(
  sub: { status: string; gracePeriodEndsAt: Date | null } | null,
  hasOverdue: boolean,
  now: Date
): CollectionState {
  if (!sub) return "NORMAL";
  if (sub.status === "SUSPENDED") return "SUSPENDED";
  if (sub.status === "GRACE") {
    return sub.gracePeriodEndsAt && sub.gracePeriodEndsAt.getTime() - now.getTime() <= SUSPENSION_RISK_WINDOW_MS ? "SUSPENSION_RISK" : "GRACE";
  }
  if (sub.status === "PAST_DUE") return "PAST_DUE";
  if (hasOverdue) return "ATTENTION";
  return "NORMAL";
}

const ATTENTION_STATES: CollectionState[] = ["ATTENTION", "PAST_DUE", "GRACE", "SUSPENSION_RISK", "SUSPENDED"];

/** Platform-only: organizations needing collections attention, prioritized. */
export async function listCollections(m: ActorMemberships, opts?: { onlyAttention?: boolean; now?: Date }) {
  requirePlatform(m);
  const now = opts?.now ?? new Date();

  const subs = await prisma.organizationSubscription.findMany({
    select: { organizationId: true, status: true, gracePeriodEndsAt: true, organization: { select: { name: true } } },
  });
  const openInvoices = await prisma.billingInvoice.findMany({
    where: { status: { in: OPEN_INVOICE_STATES } },
    select: { organizationId: true, currency: true, status: true, totalMinor: true, amountPaidMinor: true, dueAt: true },
  });

  const byOrg = new Map<string, { outstanding: CurrencyBuckets; overdue: boolean }>();
  for (const inv of openInvoices) {
    const entry = byOrg.get(inv.organizationId) ?? { outstanding: new CurrencyBuckets(), overdue: false };
    const out = invoiceOutstandingMinor(inv);
    entry.outstanding.add(inv.currency, out);
    if (out > 0 && inv.dueAt && inv.dueAt < now) entry.overdue = true;
    byOrg.set(inv.organizationId, entry);
  }

  const rows = subs.map((s) => {
    const agg = byOrg.get(s.organizationId);
    const state = deriveCollectionState(s, agg?.overdue ?? false, now);
    return { organizationId: s.organizationId, name: s.organization.name, commercialState: s.status, collectionState: state, outstanding: agg ? agg.outstanding.toArray() : [] };
  });
  const filtered = opts?.onlyAttention ? rows.filter((r) => ATTENTION_STATES.includes(r.collectionState)) : rows;
  const order: CollectionState[] = ["SUSPENDED", "SUSPENSION_RISK", "GRACE", "PAST_DUE", "ATTENTION", "NORMAL"];
  filtered.sort((a, b) => order.indexOf(a.collectionState) - order.indexOf(b.collectionState));
  return filtered;
}

/** Platform-only: record a manual collections activity note (never touches money). */
export async function recordCollectionActivity(m: ActorMemberships, input: { organizationId: string; type: string; note: string }) {
  requirePlatform(m);
  const allowed = ["NOTE", "CONTACT", "PROMISE_TO_PAY", "ESCALATION"];
  if (!allowed.includes(input.type)) throw new BadRequestError("Invalid activity type.");
  if (!input.note.trim()) throw new BadRequestError("A note is required.");
  const org = await prisma.organization.findUnique({ where: { id: input.organizationId }, select: { id: true } });
  if (!org) throw new NotFoundError();
  const row = await prisma.collectionActivity.create({ data: { organizationId: input.organizationId, type: input.type, note: input.note, createdByUserId: m.userId } });
  await recordAuditEvent("commercial.collection.activityRecorded", m.userId, { type: input.type }, { organizationId: input.organizationId });
  return row;
}

/** Tenant-scoped read of an organization's collection activity. */
export async function listCollectionActivity(m: ActorMemberships, organizationId: string) {
  assertOrganizationAccess(m, organizationId);
  return prisma.collectionActivity.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take: 100 });
}
