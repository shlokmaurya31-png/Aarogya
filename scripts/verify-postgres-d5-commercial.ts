/**
 * PHASE D5 — commercial intelligence gate (security + correctness + concurrency).
 *
 * Verifies the D5 read/operations layer: tenant isolation (mandatory), platform
 * authorization, deterministic AR/aging/outstanding, leakage detection + its
 * idempotency, reconciliation triage that never mutates money, reports, honest
 * provider health, and concurrency-safe triage. All figures come from canonical
 * D2/D3/D4 records.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-d5-commercial.ts
 */
import { prisma } from "../src/lib/db";
import { ensureCommercialBootstrap } from "../src/lib/commercial/bootstrap";
import { ensureBillingBootstrap } from "../src/lib/billing/bootstrap";
import { loadActorMemberships, type ActorMemberships } from "../src/lib/auth/tenantContext";
import { assignPlan } from "../src/lib/commercial/subscriptions";
import { generateInvoiceForPeriod, finalizeInvoiceTx } from "../src/lib/billing/invoices";
import { recordManualPayment } from "../src/lib/billing/payments";
import { getRevenueOverview, getOrganizationAR, getAging } from "../src/lib/commercial/analytics/revenueOps";
import { getPaymentFailureAnalytics } from "../src/lib/commercial/analytics/failures";
import { getMrrArr } from "../src/lib/commercial/analytics/subscriptions";
import { listCollections, listCollectionActivity } from "../src/lib/commercial/analytics/collections";
import { runLeakageDetection } from "../src/lib/commercial/analytics/leakage";
import { getReconciliationDashboard, listOrganizationExceptions, assignException, transitionException } from "../src/lib/commercial/analytics/reconciliationIntel";
import { revenueReport, arAgingReport } from "../src/lib/commercial/analytics/reports";
import { getProviderHealth } from "../src/lib/commercial/analytics/providerHealth";

const IS_PG = /^postgres/i.test(process.env.DATABASE_URL ?? "");
let pass = 0, fail = 0; const failures: string[] = [];
function ok(l: string) { pass++; console.log(`  ✓ ${l}`); }
function bad(l: string, d?: string) { fail++; failures.push(l + (d ? ` — ${d}` : "")); console.log(`  ✗ ${l}${d ? ` — ${d}` : ""}`); }
async function expectDeny(l: string, fn: () => Promise<unknown>, status?: number) {
  try { await fn(); bad(l, "expected denial but SUCCEEDED"); }
  catch (e) { const s = (e as { status?: number }).status; if (status && s !== status) bad(l, `denied ${s}, expected ${status}`); else ok(l); }
}

const ID = {
  orgA: "d5t-org-a", orgB: "d5t-org-b", facA: "d5t-fac-a", facB: "d5t-fac-b",
  uPlatform: "d5t-u-platform", uAdminA: "d5t-u-admin-a", uAdminB: "d5t-u-admin-b", uOutsider: "d5t-u-out",
};
const day = 86_400_000;

async function cleanup() {
  const orgIds = [ID.orgA, ID.orgB]; const userIds = Object.values(ID);
  await prisma.billingRefund.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.billingPayment.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.billingPaymentAttempt.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.billingInvoiceLine.deleteMany({ where: { invoice: { organizationId: { in: orgIds } } } });
  await prisma.billingCredit.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.billingInvoice.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.billingPeriod.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organizationBillingAccount.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.billingReconciliationException.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.collectionActivity.deleteMany({ where: { organizationId: { in: orgIds } } });
  const subs = await prisma.organizationSubscription.findMany({ where: { organizationId: { in: orgIds } }, select: { id: true } });
  await prisma.subscriptionEntitlement.deleteMany({ where: { subscriptionId: { in: subs.map((s) => s.id) } } });
  await prisma.organizationSubscription.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.auditEvent.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organizationMembership.deleteMany({ where: { OR: [{ organizationId: { in: orgIds } }, { userId: { in: userIds } }] } });
  await prisma.facility.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function seed() {
  const mk = (id: string, role: "AAROGYA_ADMIN" | "HOSPITAL_ADMIN" | "DOCTOR") => prisma.user.create({ data: { id, email: `${id}@d5.local`, passwordHash: "x", role, displayName: id } });
  await Promise.all([mk(ID.uPlatform, "AAROGYA_ADMIN"), mk(ID.uAdminA, "HOSPITAL_ADMIN"), mk(ID.uAdminB, "HOSPITAL_ADMIN"), mk(ID.uOutsider, "DOCTOR")]);
  for (const [org, fac] of [[ID.orgA, ID.facA], [ID.orgB, ID.facB]] as const) {
    await prisma.organization.create({ data: { id: org, slug: org, name: org, status: "ACTIVE" } });
    await prisma.facility.create({ data: { id: fac, slug: fac, name: fac, organizationId: org, status: "ACTIVE" } });
  }
  await prisma.organizationMembership.createMany({ data: [
    { userId: ID.uAdminA, organizationId: ID.orgA, isAdmin: true },
    { userId: ID.uAdminB, organizationId: ID.orgB, isAdmin: true },
  ]});
}

/** Finalize an invoice for an org, optionally pay part of it and backdate its due date. */
async function makeInvoice(actor: string, organizationId: string, isoStart: string, opts?: { payMinor?: number; dueAgeDays?: number; now?: Date }) {
  const sub = await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId } });
  const start = new Date(isoStart); const end = new Date(start); end.setMonth(end.getMonth() + 1);
  const inv = await prisma.$transaction(async (tx) => {
    const period = await tx.billingPeriod.create({ data: { subscriptionId: sub.id, organizationId, billingInterval: sub.billingInterval, periodStart: start, periodEnd: end } });
    const draft = await generateInvoiceForPeriod(tx, { organizationId, subscriptionId: sub.id, planId: sub.planId, billingInterval: sub.billingInterval, billingPeriodId: period.id, billingName: "d5", billingEmail: "", idempotencyKey: `d5:${organizationId}:${isoStart}`, generatedByUserId: actor });
    return finalizeInvoiceTx(tx, draft!.id, actor);
  }, { timeout: 20000, maxWait: 10000 });
  if (opts?.dueAgeDays != null) {
    await prisma.billingInvoice.update({ where: { id: inv.id }, data: { dueAt: new Date((opts.now ?? new Date()).getTime() - opts.dueAgeDays * day) } });
  }
  if (opts?.payMinor) {
    const mPlatform = await loadActorMemberships(ID.uPlatform, "AAROGYA_ADMIN");
    await recordManualPayment(mPlatform, { invoiceId: inv.id, amountMinor: opts.payMinor, method: "MANUAL", idempotencyKey: `d5pay:${inv.id}` });
  }
  return prisma.billingInvoice.findUniqueOrThrow({ where: { id: inv.id } });
}

async function run() {
  console.log(`\nPhase D5 commercial intelligence gate (provider: ${IS_PG ? "PostgreSQL" : "SQLite"})\n`);
  await cleanup(); await ensureCommercialBootstrap(); await ensureBillingBootstrap(); await seed(); await ensureBillingBootstrap();

  const mPlatform = await loadActorMemberships(ID.uPlatform, "AAROGYA_ADMIN");
  const mAdminA = await loadActorMemberships(ID.uAdminA, "HOSPITAL_ADMIN");
  const mOutsider = await loadActorMemberships(ID.uOutsider, "DOCTOR");
  await assignPlan(mPlatform, { organizationId: ID.orgA, planCode: "professional" });
  await assignPlan(mPlatform, { organizationId: ID.orgB, planCode: "professional" });

  const PROF = 2_499_900 + 449_982; // professional total incl 18% GST
  // orgA: one overdue-unpaid (45d), one partially paid (10d), one fully paid.
  const invOverdue = await makeInvoice(ID.uPlatform, ID.orgA, "2031-01-01", { dueAgeDays: 45 });
  const invPartial = await makeInvoice(ID.uPlatform, ID.orgA, "2031-02-01", { dueAgeDays: 10, payMinor: 1_000_000 });
  await makeInvoice(ID.uPlatform, ID.orgA, "2031-03-01", { payMinor: PROF }); // fully paid
  // orgB: one open invoice.
  await makeInvoice(ID.uPlatform, ID.orgB, "2031-01-01", { dueAgeDays: 100 });

  console.log("[tenant isolation — MANDATORY]");
  await expectDeny("org A admin cannot read org B AR", () => getOrganizationAR(mAdminA, ID.orgB), 404);
  await expectDeny("org A admin cannot read org B aging", () => getAging(mAdminA, { organizationId: ID.orgB }), 404);
  await expectDeny("org A admin cannot read org B failures", () => getPaymentFailureAnalytics(mAdminA, { organizationId: ID.orgB }), 404);
  await expectDeny("org A admin cannot read org B collection activity", () => listCollectionActivity(mAdminA, ID.orgB), 404);
  await expectDeny("org A admin cannot read org B exceptions", () => listOrganizationExceptions(mAdminA, ID.orgB), 404);
  await expectDeny("outsider cannot read org A AR", () => getOrganizationAR(mOutsider, ID.orgA), 404);

  console.log("[platform authorization]");
  await expectDeny("org admin cannot read platform revenue overview", () => getRevenueOverview(mAdminA), 403);
  await expectDeny("org admin cannot read MRR/ARR", () => getMrrArr(mAdminA), 403);
  await expectDeny("org admin cannot list platform collections", () => listCollections(mAdminA), 403);
  await expectDeny("org admin cannot read reconciliation dashboard", () => getReconciliationDashboard(mAdminA), 403);
  await expectDeny("org admin cannot run leakage detection", () => runLeakageDetection(mAdminA), 403);
  await expectDeny("org admin cannot read provider health", () => getProviderHealth(mAdminA), 403);
  await expectDeny("org admin cannot generate the revenue report", () => revenueReport(mAdminA), 403);

  console.log("[accounts receivable + outstanding correctness]");
  {
    const ar = await getOrganizationAR(mAdminA, ID.orgA);
    const inr = ar.outstanding.find((x) => x.currency === "INR")?.amountMinor ?? 0;
    const expected = PROF + (PROF - 1_000_000); // overdue full + partial remainder; fully-paid = 0
    if (inr === expected) ok(`org A outstanding = ${expected} (overdue + partial remainder, paid excluded)`); else bad("AR outstanding", `got ${inr} expected ${expected}`);
    // Both the 45d and 10d invoices are past due with a balance -> 2 overdue.
    if (ar.overdueInvoiceCount === 2 && ar.oldestOutstandingInvoice?.id === invOverdue.id) ok("oldest outstanding + overdue count correct"); else bad("AR overdue", `count=${ar.overdueInvoiceCount} oldest=${ar.oldestOutstandingInvoice?.id}`);
    void invPartial;
  }

  console.log("[aging determinism]");
  {
    const aging = await getAging(mAdminA, { organizationId: ID.orgA });
    const bucket = (k: string) => aging.buckets.find((b) => b.bucket === k)?.amounts.find((a) => a.currency === "INR")?.amountMinor ?? 0;
    // overdue 45d -> 31-60 bucket (full PROF); partial 10d -> 1-30 bucket (remainder).
    if (bucket("31-60") === PROF && bucket("1-30") === (PROF - 1_000_000)) ok("aging buckets are deterministic by dueAt"); else bad("aging", `31-60=${bucket("31-60")} 1-30=${bucket("1-30")}`);
  }

  console.log("[leakage detection + idempotency]");
  {
    // ORPHAN_PAYMENT: pay an invoice then void it (simulating a bad void).
    const inv = await makeInvoice(ID.uPlatform, ID.orgA, "2031-06-01", { payMinor: PROF });
    await prisma.billingInvoice.update({ where: { id: inv.id }, data: { status: "VOID" } });
    const r1 = await runLeakageDetection(mPlatform);
    const orphan = await prisma.billingReconciliationException.count({ where: { source: "LEAKAGE", kind: "ORPHAN_PAYMENT", organizationId: ID.orgA } });
    const mismatch = await prisma.billingReconciliationException.count({ where: { source: "LEAKAGE", kind: "COMMERCIAL_STATE_MISMATCH", organizationId: ID.orgA } });
    if (orphan >= 1 && mismatch >= 1) ok(`leakage detects ORPHAN_PAYMENT + COMMERCIAL_STATE_MISMATCH (created ${r1.created})`); else bad("leakage detect", `orphan=${orphan} mismatch=${mismatch}`);
    const before = await prisma.billingReconciliationException.count({ where: { source: "LEAKAGE" } });
    await runLeakageDetection(mPlatform);
    const after = await prisma.billingReconciliationException.count({ where: { source: "LEAKAGE" } });
    if (before === after) ok("leakage detection is idempotent (no duplicate findings)"); else bad("leakage idempotency", `before=${before} after=${after}`);
  }

  console.log("[reconciliation triage — never mutates money]");
  {
    const finding = await prisma.billingReconciliationException.findFirstOrThrow({ where: { source: "LEAKAGE", resolved: false } });
    const invBefore = await prisma.billingInvoice.aggregate({ where: { organizationId: ID.orgA }, _sum: { amountPaidMinor: true } });
    await assignException(mPlatform, finding.id, ID.uPlatform);
    await expectDeny("resolve without a note is refused", () => transitionException(mPlatform, finding.id, "RESOLVED"), 400);
    const resolved = await transitionException(mPlatform, finding.id, "RESOLVED", "investigated; benign");
    const invAfter = await prisma.billingInvoice.aggregate({ where: { organizationId: ID.orgA }, _sum: { amountPaidMinor: true } });
    if (resolved.resolved && resolved.status === "RESOLVED" && (invBefore._sum.amountPaidMinor ?? 0) === (invAfter._sum.amountPaidMinor ?? 0)) ok("resolution records outcome without changing canonical money"); else bad("recon resolve", `status=${resolved.status}`);
    await expectDeny("a terminal exception cannot transition again", () => transitionException(mPlatform, finding.id, "DISMISSED", "x"), 400);
  }

  console.log("[reports + provider health]");
  {
    const rev = await revenueReport(mPlatform);
    if (rev.rows.length > 0 && rev.csv.includes("organization,")) ok("revenue report produces canonical rows + CSV"); else bad("revenue report", `rows=${rev.rows.length}`);
    const aging = await arAgingReport(mPlatform);
    if (aging.rows.every((r: { currency: string }) => !!r.currency)) ok("AR aging report preserves the currency dimension"); else bad("aging report currency", "missing");
    const health = await getProviderHealth(mPlatform);
    const rz = health.providers.find((p: { provider: string }) => p.provider === "RAZORPAY");
    if (rz?.state === "NOT_CONFIGURED") ok("provider health shows RAZORPAY NOT_CONFIGURED (no fabricated connectivity)"); else bad("provider health", rz?.state);
  }

  await concurrency(mPlatform);

  await cleanup();
  console.log(`\n────────────────────`);
  console.log(`RESULT: ${pass} passed, ${fail} failed  (${IS_PG ? "PostgreSQL" : "SQLite"})`);
  if (fail) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

async function concurrency(mPlatform: ActorMemberships) {
  console.log("[concurrency]");
  if (!IS_PG) { console.log("  · skipped (SQLite serialises writers)"); return; }

  // Concurrent resolution of one OPEN exception -> exactly one wins.
  {
    const ex = await prisma.billingReconciliationException.create({ data: { source: "LEAKAGE", kind: "STATE_MISMATCH", organizationId: ID.orgA, severity: "HIGH", status: "OPEN", entityType: "test", entityId: "conc-1" } });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => transitionException(mPlatform, ex.id, "RESOLVED", "race")));
    const okCount = results.filter((r) => r.status === "fulfilled").length;
    const after = await prisma.billingReconciliationException.findUniqueOrThrow({ where: { id: ex.id } });
    if (okCount === 1 && after.status === "RESOLVED") ok("concurrent resolution: exactly one wins"); else bad("concurrent resolve", `ok=${okCount} status=${after.status}`);
  }

  // Concurrent leakage detection runs -> no duplicate findings.
  {
    const before = await prisma.billingReconciliationException.count({ where: { source: "LEAKAGE" } });
    await Promise.allSettled(Array.from({ length: 4 }, () => runLeakageDetection(mPlatform)));
    const after = await prisma.billingReconciliationException.count({ where: { source: "LEAKAGE" } });
    // May create at most the fixed set once; concurrent runs must not multiply them.
    const distinctEntities = await prisma.billingReconciliationException.groupBy({ by: ["kind", "entityId"], where: { source: "LEAKAGE", resolved: false }, _count: true });
    const anyDup = distinctEntities.some((g) => g._count > 1);
    if (!anyDup) ok(`concurrent leakage runs create no duplicate findings (before=${before} after=${after})`); else bad("concurrent leakage", "duplicates found");
  }
}

run().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
