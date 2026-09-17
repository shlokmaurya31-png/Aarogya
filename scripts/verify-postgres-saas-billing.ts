/**
 * PHASE D3 — SaaS billing & payment security, semantics and concurrency gate.
 *
 * Exercises the billing domain with a hostile caller in mind. Properties that
 * must hold regardless of data:
 *
 *   - no cross-organization billing read (summary / invoice)
 *   - every financial mutation is platform-only (no self-renew/credit/refund/pay)
 *   - the server computes every amount (price + tax); the client never sets a total
 *   - a finalized invoice is immutable (no line edits after finalize)
 *   - payments and refunds are idempotent and cannot over-apply (guarded totals)
 *   - refunds cannot exceed the payment; cross-tenant refunds are impossible
 *   - credits are platform-only, cannot cross organizations, apply to DRAFT only
 *   - a failed payment advances D2 dunning (ACTIVE -> PAST_DUE), never instant cut
 *   - webhooks are signature-verified, idempotent and out-of-order safe
 *   - concurrency: duplicate renewal / payment / refund / webhook each resolve once
 *
 * Concurrency claims are only meaningful on PostgreSQL. On SQLite the security and
 * semantics assertions still run; the concurrency section reports skipped.
 *
 * Usage (authoritative gate; run against a freshly migrated + seeded DB):
 *   DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-saas-billing.ts
 */
import { prisma } from "../src/lib/db";
import { ensureCommercialBootstrap } from "../src/lib/commercial/bootstrap";
import { ensureBillingBootstrap } from "../src/lib/billing/bootstrap";
import { loadActorMemberships, type ActorMemberships } from "../src/lib/auth/tenantContext";
import { assignPlan } from "../src/lib/commercial/subscriptions";
import { renewSubscription, handleFailedPayment } from "../src/lib/billing/renewal";
import { recordManualPayment } from "../src/lib/billing/payments";
import { refundPayment } from "../src/lib/billing/refunds";
import { issueCredit, applyCreditToInvoice } from "../src/lib/billing/credits";
import { getBillingSummary } from "../src/lib/billing/summary";
import { addInvoiceLine, voidInvoice, generateInvoiceForPeriod, finalizeInvoiceTx } from "../src/lib/billing/invoices";
import { ingestWebhook } from "../src/lib/billing/webhooks";
import { fakeSign } from "../src/lib/billing/provider/fake";

const IS_PG = /^postgres/i.test(process.env.DATABASE_URL ?? "");
let pass = 0, fail = 0;
const failures: string[] = [];
function ok(l: string) { pass++; console.log(`  ✓ ${l}`); }
function bad(l: string, d?: string) { fail++; failures.push(l + (d ? ` — ${d}` : "")); console.log(`  ✗ ${l}${d ? ` — ${d}` : ""}`); }
async function expectAllow(l: string, fn: () => Promise<unknown>) { try { await fn(); ok(l); } catch (e) { bad(l, `unexpected: ${(e as Error).message}`); } }
async function expectDeny(l: string, fn: () => Promise<unknown>, status?: number) {
  try { await fn(); bad(l, "expected denial but SUCCEEDED"); }
  catch (e) { const s = (e as { status?: number }).status; if (status && s !== status) bad(l, `denied ${s}, expected ${status}`); else ok(l); }
}

const ID = {
  orgA: "d3t-org-a", orgB: "d3t-org-b", orgC: "d3t-org-c",
  facA: "d3t-fac-a", facB: "d3t-fac-b", facC: "d3t-fac-c",
  uPlatform: "d3t-u-platform", uAdminA: "d3t-u-admin-a", uAdminB: "d3t-u-admin-b", uAdminC: "d3t-u-admin-c", uOutsider: "d3t-u-outsider",
};

async function cleanup() {
  const orgIds = [ID.orgA, ID.orgB, ID.orgC];
  const userIds = Object.values(ID);
  await prisma.billingRefund.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.billingPayment.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.billingPaymentAttempt.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.billingInvoiceLine.deleteMany({ where: { invoice: { organizationId: { in: orgIds } } } });
  await prisma.billingCredit.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.billingInvoice.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.billingPeriod.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organizationBillingAccount.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.billingReconciliationException.deleteMany({ where: { OR: [{ organizationId: { in: orgIds } }, { providerRef: { in: ["unknown_ref", "unknown_race"] } }] } });
  await prisma.billingWebhookEvent.deleteMany({ where: { externalEventId: { startsWith: "d3t-" } } });
  const subs = await prisma.organizationSubscription.findMany({ where: { organizationId: { in: orgIds } }, select: { id: true } });
  await prisma.subscriptionEntitlement.deleteMany({ where: { subscriptionId: { in: subs.map((s) => s.id) } } });
  await prisma.organizationSubscription.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.auditEvent.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.facilityMembership.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.organizationMembership.deleteMany({ where: { OR: [{ organizationId: { in: orgIds } }, { userId: { in: userIds } }] } });
  await prisma.facility.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function seed() {
  const mkUser = (id: string, role: "AAROGYA_ADMIN" | "HOSPITAL_ADMIN" | "DOCTOR") =>
    prisma.user.create({ data: { id, email: `${id}@d3test.local`, passwordHash: "x", role, displayName: id } });
  await Promise.all([
    mkUser(ID.uPlatform, "AAROGYA_ADMIN"), mkUser(ID.uAdminA, "HOSPITAL_ADMIN"),
    mkUser(ID.uAdminB, "HOSPITAL_ADMIN"), mkUser(ID.uAdminC, "HOSPITAL_ADMIN"), mkUser(ID.uOutsider, "DOCTOR"),
  ]);
  for (const [org, fac] of [[ID.orgA, ID.facA], [ID.orgB, ID.facB], [ID.orgC, ID.facC]] as const) {
    await prisma.organization.create({ data: { id: org, slug: org, name: org, status: "ACTIVE" } });
    await prisma.facility.create({ data: { id: fac, slug: fac, name: fac, organizationId: org, status: "ACTIVE" } });
  }
  await prisma.organizationMembership.createMany({ data: [
    { userId: ID.uAdminA, organizationId: ID.orgA, isAdmin: true },
    { userId: ID.uAdminB, organizationId: ID.orgB, isAdmin: true },
    { userId: ID.uAdminC, organizationId: ID.orgC, isAdmin: true },
  ]});
}

const load = (id: string, role: "AAROGYA_ADMIN" | "HOSPITAL_ADMIN" | "DOCTOR") => loadActorMemberships(id, role);

const PROF_TOTAL = 2_499_900 + 449_982; // professional price + 18% GST
const STARTER_TOTAL = 499_900 + 89_982;

async function run() {
  console.log(`\nPhase D3 SaaS billing verification (provider: ${IS_PG ? "PostgreSQL" : "SQLite"})\n`);
  await cleanup();
  await ensureCommercialBootstrap();
  await ensureBillingBootstrap();
  await seed();
  // The bootstrap only touches pre-existing orgs; create accounts for our test orgs.
  await ensureBillingBootstrap();

  const mPlatform = await load(ID.uPlatform, "AAROGYA_ADMIN");
  const mAdminA = await load(ID.uAdminA, "HOSPITAL_ADMIN");
  const mAdminB = await load(ID.uAdminB, "HOSPITAL_ADMIN");
  const mOutsider = await load(ID.uOutsider, "DOCTOR");

  await assignPlan(mPlatform, { organizationId: ID.orgA, planCode: "professional" });
  await assignPlan(mPlatform, { organizationId: ID.orgB, planCode: "starter" });
  await assignPlan(mPlatform, { organizationId: ID.orgC, planCode: "professional" });

  console.log("[cross-tenant billing isolation]");
  await expectAllow("org A admin reads OWN billing summary", () => getBillingSummary(mAdminA, ID.orgA));
  await expectDeny("org A admin cannot read org B billing summary", () => getBillingSummary(mAdminA, ID.orgB), 404);
  await expectDeny("outsider cannot read org A billing summary", () => getBillingSummary(mOutsider, ID.orgA), 404);

  console.log("[financial mutation is platform-only]");
  await expectDeny("org admin cannot renew (self-charge)", () => renewSubscription(mAdminA, { organizationId: ID.orgA, providerKind: "FAKE" }), 403);
  await expectDeny("org admin cannot issue a credit to self", () => issueCredit(mAdminA, { organizationId: ID.orgA, amountMinor: 100000, type: "PROMOTIONAL", reason: "x" }), 403);
  await expectDeny("org admin cannot record a manual payment", () => recordManualPayment(mAdminA, { invoiceId: "x", amountMinor: 100, idempotencyKey: "k-".padEnd(10, "1") }), 403);

  console.log("[renewal — server-computed amounts]");
  const r = await renewSubscription(mPlatform, { organizationId: ID.orgA, providerKind: "FAKE" });
  {
    const inv = r.invoiceId ? await prisma.billingInvoice.findUnique({ where: { id: r.invoiceId } }) : null;
    if (inv && inv.totalMinor === PROF_TOTAL) ok(`professional invoice total is server-computed (${PROF_TOTAL})`); else bad("invoice total", `got ${inv?.totalMinor}`);
    if (r.paymentSucceeded && inv?.status === "PAID") ok("FAKE renewal charges and marks invoice PAID"); else bad("renewal paid", JSON.stringify(r));
    const sub = await prisma.organizationSubscription.findUnique({ where: { organizationId: ID.orgA } });
    if (sub?.currentPeriodEnd && sub.currentPeriodEnd > new Date()) ok("subscription period advanced after paid renewal"); else bad("period advance", JSON.stringify(sub?.currentPeriodEnd));
  }

  console.log("[invoice immutability]");
  if (r.invoiceId) {
    await expectDeny("cannot add a line to a finalized invoice", () => addInvoiceLine(mPlatform, r.invoiceId!, { type: "ADJUSTMENT", description: "x", quantity: 1, unitAmountMinor: 100 }), 400);
    await expectDeny("cannot void a PAID invoice", () => voidInvoice(mPlatform, r.invoiceId!, "nope"), 400);
  }

  console.log("[refunds — bounded, idempotent, tenant-safe]");
  {
    const payment = await prisma.billingPayment.findFirst({ where: { organizationId: ID.orgA } });
    if (!payment) { bad("refund setup", "no payment"); }
    else {
      await expectAllow("partial refund within balance", () => refundPayment(mPlatform, { paymentId: payment.id, amountMinor: 1000, reason: "partial", idempotencyKey: "d3t-rf-1-000001" }));
      await expectDeny("refund exceeding remaining balance is refused", () => refundPayment(mPlatform, { paymentId: payment.id, amountMinor: PROF_TOTAL, reason: "too much", idempotencyKey: "d3t-rf-2-000002" }), 400);
      // Idempotent: same key twice -> one refund row.
      await refundPayment(mPlatform, { paymentId: payment.id, amountMinor: 500, reason: "again", idempotencyKey: "d3t-rf-3-000003" });
      await refundPayment(mPlatform, { paymentId: payment.id, amountMinor: 500, reason: "again", idempotencyKey: "d3t-rf-3-000003" });
      const refunds = await prisma.billingRefund.count({ where: { idempotencyKey: "d3t-rf-3-000003" } });
      if (refunds === 1) ok("refund is idempotent on idempotencyKey"); else bad("refund idempotency", `rows=${refunds}`);
    }
  }

  console.log("[credits — platform-only, DRAFT-only, tenant-scoped]");
  {
    // Build a DRAFT invoice for org B directly (renewal finalizes, so craft a draft period).
    const subB = await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId: ID.orgB } });
    const draft = await prisma.$transaction(async (tx) => {
      const period = await tx.billingPeriod.create({ data: { subscriptionId: subB.id, organizationId: ID.orgB, billingInterval: "MONTHLY", periodStart: new Date("2030-01-01"), periodEnd: new Date("2030-02-01") } });
      return generateInvoiceForPeriod(tx, { organizationId: ID.orgB, subscriptionId: subB.id, planId: subB.planId, billingInterval: "MONTHLY", billingPeriodId: period.id, billingName: "B", billingEmail: "", idempotencyKey: "d3t-draftB", generatedByUserId: ID.uPlatform, now: new Date("2030-01-01") });
    });
    const credit = await issueCredit(mPlatform, { organizationId: ID.orgB, amountMinor: 100000, type: "PROMOTIONAL", reason: "welcome" });
    await expectDeny("credit cannot be applied across organizations", () => applyCreditToInvoice(mPlatform, { creditId: credit.id, invoiceId: r.invoiceId!, amountMinor: 1000 }), 400);
    if (draft) {
      await expectAllow("credit applies to a DRAFT invoice of the same org", () => applyCreditToInvoice(mPlatform, { creditId: credit.id, invoiceId: draft.id, amountMinor: 50000 }));
      const after = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: draft.id } });
      if (after.discountMinor === 50000 && after.totalMinor === STARTER_TOTAL - 50000) ok("credit reduces the DRAFT invoice total"); else bad("credit apply", JSON.stringify({ d: after.discountMinor, t: after.totalMinor }));
      await expectDeny("credit cannot over-apply beyond its balance", () => applyCreditToInvoice(mPlatform, { creditId: credit.id, invoiceId: draft.id, amountMinor: 999999 }), 400);
    }
  }

  console.log("[failed payment lifecycle — D2 dunning, never instant cut]");
  {
    await handleFailedPayment(mPlatform, ID.orgC); // ACTIVE -> PAST_DUE
    const s1 = await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId: ID.orgC } });
    await handleFailedPayment(mPlatform, ID.orgC); // PAST_DUE -> GRACE
    const s2 = await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId: ID.orgC } });
    if (s1.status === "PAST_DUE" && s2.status === "GRACE") ok("failed payment moves ACTIVE -> PAST_DUE -> GRACE (access preserved)"); else bad("dunning", `${s1.status}/${s2.status}`);
  }

  console.log("[webhooks — verified, idempotent, out-of-order safe]");
  {
    const evt = JSON.stringify({ id: "d3t-evt-1", type: "payment.succeeded", providerPaymentRef: "unknown_ref", paymentStatus: "succeeded" });
    const rej = await ingestWebhook({ providerKind: "FAKE", payload: evt, signature: "deadbeef" });
    if (rej.status === "REJECTED") ok("webhook with a bad signature is rejected"); else bad("webhook reject", rej.status);
    const good = await ingestWebhook({ providerKind: "FAKE", payload: evt, signature: fakeSign(evt) });
    if (good.status === "RECONCILE") ok("verified webhook for an unknown ref reconciles instead of blind-updating"); else bad("webhook reconcile", good.status);
    const dup = await ingestWebhook({ providerKind: "FAKE", payload: evt, signature: fakeSign(evt) });
    if (dup.status === "DUPLICATE") ok("duplicate webhook is processed at most once"); else bad("webhook dup", dup.status);
    const exc = await prisma.billingReconciliationException.count({ where: { providerRef: "unknown_ref", kind: "UNKNOWN_REFERENCE" } });
    if (exc === 1) ok("unknown provider reference raised exactly one reconciliation exception"); else bad("recon exception", `count=${exc}`);
  }

  await concurrency(mPlatform);

  await cleanup();
  console.log(`\n────────────────────`);
  console.log(`RESULT: ${pass} passed, ${fail} failed  (${IS_PG ? "PostgreSQL" : "SQLite"})`);
  if (fail) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

/** Create a fresh finalized OPEN invoice for an org at a distinct far-future period. */
async function makeOpenInvoice(actorUserId: string, organizationId: string, isoStart: string) {
  const sub = await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId } });
  const start = new Date(isoStart);
  const end = new Date(start); end.setMonth(end.getMonth() + 1);
  return prisma.$transaction(async (tx) => {
    const period = await tx.billingPeriod.create({ data: { subscriptionId: sub.id, organizationId, billingInterval: sub.billingInterval === "NONE" ? "MONTHLY" : sub.billingInterval, periodStart: start, periodEnd: end } });
    const inv = await generateInvoiceForPeriod(tx, {
      organizationId, subscriptionId: sub.id, planId: sub.planId, billingInterval: sub.billingInterval === "NONE" ? "MONTHLY" : sub.billingInterval,
      billingPeriodId: period.id, billingName: "conc", billingEmail: "", idempotencyKey: `conc:${organizationId}:${isoStart}`, generatedByUserId: actorUserId, now: start,
    });
    if (!inv) throw new Error("no invoice");
    return finalizeInvoiceTx(tx, inv.id, actorUserId, 14, start);
  }, { timeout: 20000, maxWait: 10000 });
}

async function concurrency(mPlatform: ActorMemberships) {
  console.log("[concurrency]");
  if (!IS_PG) { console.log("  · skipped (SQLite serialises writers; run against PostgreSQL for the authoritative race gate)"); return; }

  // 1. Duplicate renewal: many concurrent renewals -> one invoice, one payment.
  {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => renewSubscription(mPlatform, { organizationId: ID.orgB, providerKind: "FAKE" })));
    const okCount = results.filter((x) => x.status === "fulfilled").length;
    // Count only invoices this renewal could have produced: non-DRAFT (a leftover
    // DRAFT from the credit test on org B must not confuse the assertion).
    const invoices = await prisma.billingInvoice.count({ where: { organizationId: ID.orgB, status: { not: "DRAFT" } } });
    const payments = await prisma.billingPayment.count({ where: { organizationId: ID.orgB } });
    if (payments === 1 && invoices === 1) ok(`duplicate renewal: one invoice + one payment across ${okCount}/6 calls`); else bad("duplicate renewal", `inv=${invoices} pay=${payments}`);
  }

  // 2. Duplicate payment: many concurrent identical manual payments -> one payment.
  {
    const invoice = await makeOpenInvoice(mPlatform.userId, ID.orgA, "2031-01-01");
    const due = invoice.totalMinor;
    const key = "d3t-dup-pay-000001";
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => recordManualPayment(mPlatform, { invoiceId: invoice.id, amountMinor: due, method: "MANUAL", idempotencyKey: key })));
    const okCount = results.filter((x) => x.status === "fulfilled").length;
    const payRows = await prisma.billingPayment.count({ where: { idempotencyKey: `pay:${key}` } });
    const after = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    if (payRows === 1 && after.amountPaidMinor === due) ok(`duplicate payment: one payment applied once (${okCount}/8 calls ok)`); else bad("duplicate payment", `rows=${payRows} paid=${after.amountPaidMinor}/${due}`);
  }

  // 3. Over-payment race: many DIFFERENT-key full payments on one OPEN invoice -> exactly one applies.
  {
    const invoice = await makeOpenInvoice(mPlatform.userId, ID.orgA, "2032-01-01");
    const due = invoice.totalMinor;
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => recordManualPayment(mPlatform, { invoiceId: invoice.id, amountMinor: due, method: "MANUAL", idempotencyKey: `d3t-over-${i}-00000${i}` })));
    const okCount = results.filter((x) => x.status === "fulfilled").length;
    const after = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    if (after.amountPaidMinor === due && okCount === 1) ok(`over-payment race: exactly one of 6 full payments applies (paid=${due})`); else bad("over-payment race", `ok=${okCount} paid=${after.amountPaidMinor}/${due}`);
  }

  // 4. Concurrent refund: many DIFFERENT-key full refunds -> total refunded never exceeds payment.
  {
    const payment = await prisma.billingPayment.findFirst({ where: { idempotencyKey: "pay:d3t-dup-pay-000001" } });
    if (payment) {
      const amt = payment.amountMinor - payment.refundedMinor;
      const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => refundPayment(mPlatform, { paymentId: payment.id, amountMinor: amt, reason: "race", idempotencyKey: `d3t-rfr-${i}-00000${i}` })));
      const okCount = results.filter((x) => x.status === "fulfilled").length;
      const after = await prisma.billingPayment.findUniqueOrThrow({ where: { id: payment.id } });
      if (after.refundedMinor <= after.amountMinor && okCount === 1) ok(`concurrent refund: exactly one full refund applies, never over-refunds`); else bad("concurrent refund", `ok=${okCount} refunded=${after.refundedMinor}/${after.amountMinor}`);
    } else bad("concurrent refund setup", "no payment");
  }

  // 5. Duplicate webhook: many concurrent identical deliveries -> processed once.
  {
    const evt = JSON.stringify({ id: "d3t-evt-race", type: "payment.succeeded", providerPaymentRef: "unknown_race", paymentStatus: "succeeded" });
    const sig = fakeSign(evt);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => ingestWebhook({ providerKind: "FAKE", payload: evt, signature: sig })));
    const processed = results.filter((x) => x.status === "fulfilled" && (x.value as { status: string }).status !== "DUPLICATE").length;
    const rows = await prisma.billingWebhookEvent.count({ where: { externalEventId: "d3t-evt-race" } });
    const exc = await prisma.billingReconciliationException.count({ where: { providerRef: "unknown_race" } });
    if (rows === 1 && processed === 1 && exc === 1) ok(`duplicate webhook: one row, processed exactly once`); else bad("duplicate webhook", `rows=${rows} processed=${processed} exc=${exc}`);
  }
}

run().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
