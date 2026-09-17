/**
 * PHASE D4 — provider productionization gate (security + semantics + concurrency).
 *
 * Verifies the D4 additions on top of D3: the async provider capture path
 * (order -> payment.captured webhook), webhook idempotency / state-machine
 * guards / out-of-order safety / reconciliation, dunning (one step per run,
 * never instant suspend), customer-sync + provider-refund idempotency and
 * distributed-failure discipline, plus concurrency and adversarial checks.
 *
 * RAZORPAY webhook tests use a TEST webhook secret set below and make NO network
 * call (webhook ingestion only verifies signatures + parses). Provider API calls
 * (customer create, refund) use the deterministic FAKE. This is ADAPTER-VERIFIED,
 * not sandbox/production verified.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-d4-billing.ts
 */
process.env.RAZORPAY_KEY_ID ||= "rzp_test_gate";
process.env.RAZORPAY_KEY_SECRET ||= "test_secret_gate";
process.env.RAZORPAY_WEBHOOK_SECRET ||= "whsec_gate";

import { createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { ensureCommercialBootstrap } from "../src/lib/commercial/bootstrap";
import { ensureBillingBootstrap } from "../src/lib/billing/bootstrap";
import { loadActorMemberships, type ActorMemberships } from "../src/lib/auth/tenantContext";
import { assignPlan } from "../src/lib/commercial/subscriptions";
import { generateInvoiceForPeriod, finalizeInvoiceTx } from "../src/lib/billing/invoices";
import { ingestWebhook } from "../src/lib/billing/webhooks";
import { processBillingDunning } from "../src/lib/billing/dunning";
import { syncProviderCustomer } from "../src/lib/billing/billingAccount";
import { refundViaProvider } from "../src/lib/billing/refunds";
import { recordManualPayment } from "../src/lib/billing/payments";

const IS_PG = /^postgres/i.test(process.env.DATABASE_URL ?? "");
let pass = 0, fail = 0; const failures: string[] = [];
function ok(l: string) { pass++; console.log(`  ✓ ${l}`); }
function bad(l: string, d?: string) { fail++; failures.push(l + (d ? ` — ${d}` : "")); console.log(`  ✗ ${l}${d ? ` — ${d}` : ""}`); }
async function expectDeny(l: string, fn: () => Promise<unknown>, status?: number) {
  try { await fn(); bad(l, "expected denial but SUCCEEDED"); }
  catch (e) { const s = (e as { status?: number }).status; if (status && s !== status) bad(l, `denied ${s}, expected ${status}`); else ok(l); }
}

const WHSEC = process.env.RAZORPAY_WEBHOOK_SECRET!;
const sign = (payload: string) => createHmac("sha256", WHSEC).update(payload).digest("hex");
const captureEvent = (order: string, pay: string, amount: number) => JSON.stringify({
  event: "payment.captured", created_at: 1700000000,
  payload: { payment: { entity: { id: pay, order_id: order, amount, status: "captured" } } },
});

const ID = {
  orgA: "d4t-org-a", orgB: "d4t-org-b", facA: "d4t-fac-a", facB: "d4t-fac-b",
  uPlatform: "d4t-u-platform", uAdminA: "d4t-u-admin-a", uAdminB: "d4t-u-admin-b",
};

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
  await prisma.billingReconciliationException.deleteMany({ where: { OR: [{ organizationId: { in: orgIds } }, { providerRef: { startsWith: "order_d4t" } }, { providerRef: { startsWith: "unknown_d4t" } }] } });
  await prisma.billingWebhookEvent.deleteMany({ where: { OR: [{ externalEventId: { startsWith: "d4t-" } }, { providerResourceRef: { startsWith: "order_d4t" } }] } });
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
  const mk = (id: string, role: "AAROGYA_ADMIN" | "HOSPITAL_ADMIN") => prisma.user.create({ data: { id, email: `${id}@d4.local`, passwordHash: "x", role, displayName: id } });
  await Promise.all([mk(ID.uPlatform, "AAROGYA_ADMIN"), mk(ID.uAdminA, "HOSPITAL_ADMIN"), mk(ID.uAdminB, "HOSPITAL_ADMIN")]);
  for (const [org, fac] of [[ID.orgA, ID.facA], [ID.orgB, ID.facB]] as const) {
    await prisma.organization.create({ data: { id: org, slug: org, name: org, status: "ACTIVE" } });
    await prisma.facility.create({ data: { id: fac, slug: fac, name: fac, organizationId: org, status: "ACTIVE" } });
  }
  await prisma.organizationMembership.createMany({ data: [
    { userId: ID.uAdminA, organizationId: ID.orgA, isAdmin: true },
    { userId: ID.uAdminB, organizationId: ID.orgB, isAdmin: true },
  ]});
}

/** Create a finalized OPEN invoice + a PENDING Razorpay attempt (order) for it. */
async function makeInvoiceWithOrder(actor: string, organizationId: string, order: string, isoStart: string) {
  const sub = await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId } });
  const start = new Date(isoStart); const end = new Date(start); end.setMonth(end.getMonth() + 1);
  const invoice = await prisma.$transaction(async (tx) => {
    const period = await tx.billingPeriod.create({ data: { subscriptionId: sub.id, organizationId, billingInterval: sub.billingInterval, periodStart: start, periodEnd: end } });
    const inv = await generateInvoiceForPeriod(tx, { organizationId, subscriptionId: sub.id, planId: sub.planId, billingInterval: sub.billingInterval, billingPeriodId: period.id, billingName: "d4", billingEmail: "", idempotencyKey: `d4:${order}`, generatedByUserId: actor, now: start });
    return finalizeInvoiceTx(tx, inv!.id, actor, 14, start);
  }, { timeout: 20000, maxWait: 10000 });
  await prisma.billingPaymentAttempt.create({ data: { invoiceId: invoice.id, organizationId, amountMinor: invoice.totalMinor, currency: invoice.currency, status: "PENDING", idempotencyKey: `att:${order}`, providerKind: "RAZORPAY", providerRequestRef: order } });
  return invoice;
}

async function run() {
  console.log(`\nPhase D4 provider productionization gate (provider: ${IS_PG ? "PostgreSQL" : "SQLite"})\n`);
  await cleanup(); await ensureCommercialBootstrap(); await ensureBillingBootstrap(); await seed(); await ensureBillingBootstrap();

  const mPlatform = await loadActorMemberships(ID.uPlatform, "AAROGYA_ADMIN");
  const mAdminA = await loadActorMemberships(ID.uAdminA, "HOSPITAL_ADMIN");
  await assignPlan(mPlatform, { organizationId: ID.orgA, planCode: "professional" });
  await assignPlan(mPlatform, { organizationId: ID.orgB, planCode: "professional" });

  console.log("[async capture path]");
  {
    const inv = await makeInvoiceWithOrder(ID.uPlatform, ID.orgA, "order_d4t_1", "2031-01-01");
    const evt = captureEvent("order_d4t_1", "pay_d4t_1", inv.totalMinor);
    const r = await ingestWebhook({ providerKind: "RAZORPAY", payload: evt, signature: sign(evt), eventIdHint: "d4t-evt-1" });
    const after = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    const pay = await prisma.billingPayment.count({ where: { invoiceId: inv.id } });
    const att = await prisma.billingPaymentAttempt.findFirstOrThrow({ where: { providerRequestRef: "order_d4t_1" } });
    if (r.status === "PROCESSED" && after.status === "PAID" && pay === 1 && att.status === "SUCCEEDED") ok("payment.captured records payment, marks attempt SUCCEEDED, invoice PAID"); else bad("capture", `${r.status} inv=${after.status} pay=${pay} att=${att.status}`);
    const sub = await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId: ID.orgA } });
    if (sub.currentPeriodEnd && sub.currentPeriodEnd >= new Date("2031-02-01")) ok("renewal period advanced on capture"); else bad("capture renewal", String(sub.currentPeriodEnd));
  }

  console.log("[webhook idempotency + state guards + reconcile]");
  {
    const evt = captureEvent("order_d4t_1", "pay_d4t_1", 2_949_882);
    const dup = await ingestWebhook({ providerKind: "RAZORPAY", payload: evt, signature: sign(evt), eventIdHint: "d4t-evt-1" });
    if (dup.status === "DUPLICATE") ok("duplicate capture event is a no-op"); else bad("dup capture", dup.status);
    // Out-of-order: a failure after capture must not move a SUCCEEDED attempt.
    const failEvt = JSON.stringify({ event: "payment.failed", payload: { payment: { entity: { id: "pay_d4t_1", order_id: "order_d4t_1", status: "failed", error_code: "x" } } } });
    const late = await ingestWebhook({ providerKind: "RAZORPAY", payload: failEvt, signature: sign(failEvt), eventIdHint: "d4t-evt-late" });
    const att = await prisma.billingPaymentAttempt.findFirstOrThrow({ where: { providerRequestRef: "order_d4t_1" } });
    if (att.status === "SUCCEEDED" && (late.status === "DUPLICATE" || late.status === "PROCESSED")) ok("stale failure after capture does not revert a SUCCEEDED attempt"); else bad("out-of-order", `${late.status}/${att.status}`);
    // Amount mismatch -> reconcile.
    const inv2 = await makeInvoiceWithOrder(ID.uPlatform, ID.orgA, "order_d4t_mm", "2032-01-01");
    void inv2;
    const mmEvt = captureEvent("order_d4t_mm", "pay_d4t_mm", 999);
    const mm = await ingestWebhook({ providerKind: "RAZORPAY", payload: mmEvt, signature: sign(mmEvt), eventIdHint: "d4t-evt-mm" });
    const mmExc = await prisma.billingReconciliationException.count({ where: { kind: "STATE_MISMATCH", providerRef: "order_d4t_mm" } });
    if (mm.status === "RECONCILE" && mmExc === 1) ok("amount mismatch reconciles, does not record payment"); else bad("amount mismatch", `${mm.status} exc=${mmExc}`);
    // Unknown order -> reconcile.
    const unkEvt = captureEvent("order_d4t_unknown", "pay_d4t_u", 100);
    const unk = await ingestWebhook({ providerKind: "RAZORPAY", payload: unkEvt, signature: sign(unkEvt), eventIdHint: "d4t-evt-unk" });
    if (unk.status === "RECONCILE") ok("capture for unknown order reconciles, never fabricates"); else bad("unknown order", unk.status);
    // Signature spoofing.
    const spoof = await ingestWebhook({ providerKind: "RAZORPAY", payload: evt, signature: "deadbeef", eventIdHint: "d4t-evt-spoof" });
    if (spoof.status === "REJECTED") ok("invalid webhook signature is rejected"); else bad("spoof", spoof.status);
  }

  console.log("[dunning — one step per run, never instant suspend]");
  {
    // Overdue OPEN invoice for org B (past due date).
    const subB = await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId: ID.orgB } });
    const dunInv = await prisma.$transaction(async (tx) => {
      const period = await tx.billingPeriod.create({ data: { subscriptionId: subB.id, organizationId: ID.orgB, billingInterval: "MONTHLY", periodStart: new Date("2020-01-01"), periodEnd: new Date("2020-02-01") } });
      const inv = await generateInvoiceForPeriod(tx, { organizationId: ID.orgB, subscriptionId: subB.id, planId: subB.planId, billingInterval: "MONTHLY", billingPeriodId: period.id, billingName: "d4", billingEmail: "", idempotencyKey: "d4:dun", generatedByUserId: ID.uPlatform });
      return finalizeInvoiceTx(tx, inv!.id, ID.uPlatform, 14);
    }, { timeout: 20000, maxWait: 10000 });
    // Backdate the due date so the invoice is genuinely overdue for dunning.
    await prisma.billingInvoice.update({ where: { id: dunInv.id }, data: { dueAt: new Date("2020-01-15") } });
    const r1 = await processBillingDunning(mPlatform); void r1;
    const s1 = await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId: ID.orgB } });
    const r2 = await processBillingDunning(mPlatform); void r2;
    const s2 = await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId: ID.orgB } });
    // Force grace elapsed, then suspend on the next run.
    await prisma.organizationSubscription.update({ where: { organizationId: ID.orgB }, data: { gracePeriodEndsAt: new Date("2020-01-01") } });
    await processBillingDunning(mPlatform);
    const s3 = await prisma.organizationSubscription.findUniqueOrThrow({ where: { organizationId: ID.orgB } });
    if (s1.status === "PAST_DUE" && s2.status === "GRACE" && s3.status === "SUSPENDED") ok("dunning advances ACTIVE->PAST_DUE->GRACE->SUSPENDED one step per run"); else bad("dunning", `${s1.status}/${s2.status}/${s3.status}`);
  }

  console.log("[customer sync + provider refund idempotency]");
  {
    const a1 = await syncProviderCustomer(mPlatform, ID.orgA, "FAKE");
    const a2 = await syncProviderCustomer(mPlatform, ID.orgA, "FAKE");
    if (a1.providerCustomerRef && a1.providerCustomerRef === a2.providerCustomerRef) ok("customer sync is idempotent (one provider ref)"); else bad("customer sync", `${a1.providerCustomerRef}/${a2.providerCustomerRef}`);
    // A real (FAKE-provider) payment to refund: manual payment on a fresh invoice.
    const inv = await makeInvoiceWithOrder(ID.uPlatform, ID.orgA, "order_d4t_rf", "2034-01-01");
    // Turn the pending order attempt into a real payment via capture, then refund via provider.
    const evt = captureEvent("order_d4t_rf", "pay_d4t_rf", inv.totalMinor);
    await ingestWebhook({ providerKind: "RAZORPAY", payload: evt, signature: sign(evt), eventIdHint: "d4t-evt-rf" });
    const payment = await prisma.billingPayment.findFirstOrThrow({ where: { providerPaymentRef: "pay_d4t_rf" } });
    const r1 = await refundViaProvider(mPlatform, { paymentId: payment.id, amountMinor: 1000, reason: "x", idempotencyKey: "d4t-rfp-000001", providerKind: "FAKE" });
    const r2 = await refundViaProvider(mPlatform, { paymentId: payment.id, amountMinor: 1000, reason: "x", idempotencyKey: "d4t-rfp-000001", providerKind: "FAKE" });
    const rows = await prisma.billingRefund.count({ where: { idempotencyKey: "d4t-rfp-000001" } });
    if (r1.id === r2.id && rows === 1) ok("provider refund is idempotent (no double refund)"); else bad("provider refund idem", `rows=${rows}`);
  }

  console.log("[adversarial — platform-only D4 operations]");
  await expectDeny("org admin cannot run dunning", () => processBillingDunning(mAdminA), 403);
  await expectDeny("org admin cannot sync provider customer", () => syncProviderCustomer(mAdminA, ID.orgA, "FAKE"), 404);
  await expectDeny("org admin cannot provider-refund", () => refundViaProvider(mAdminA, { paymentId: "x", amountMinor: 1, reason: "x", idempotencyKey: "d4t-adv-000001", providerKind: "FAKE" }), 403);

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
  void Prisma;

  // Concurrent duplicate capture webhooks -> exactly one payment.
  {
    const inv = await makeInvoiceWithOrder(ID.uPlatform, ID.orgA, "order_d4t_race", "2035-01-01");
    const evt = captureEvent("order_d4t_race", "pay_d4t_race", inv.totalMinor);
    const sig = sign(evt);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => ingestWebhook({ providerKind: "RAZORPAY", payload: evt, signature: sig, eventIdHint: "d4t-evt-race" })));
    const processed = results.filter((x) => x.status === "fulfilled" && (x.value as { status: string }).status === "PROCESSED").length;
    const pay = await prisma.billingPayment.count({ where: { invoiceId: inv.id } });
    if (pay === 1 && processed === 1) ok("concurrent duplicate captures record exactly one payment"); else bad("concurrent capture", `pay=${pay} processed=${processed}`);
  }

  // Concurrent customer sync -> one provider ref.
  {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => syncProviderCustomer(mPlatform, ID.orgB, "FAKE")));
    void results;
    const acct = await prisma.organizationBillingAccount.findUniqueOrThrow({ where: { organizationId: ID.orgB } });
    const refs = new Set((await prisma.organizationBillingAccount.findMany({ where: { organizationId: ID.orgB }, select: { providerCustomerRef: true } })).map((a) => a.providerCustomerRef));
    if (acct.providerCustomerRef && refs.size === 1) ok("concurrent customer sync converges to one provider ref"); else bad("concurrent sync", `refs=${refs.size}`);
  }

  // Concurrent manual payments same key on one invoice (D3 invariant still holds under D4).
  {
    const inv = await makeInvoiceWithOrder(ID.uPlatform, ID.orgA, "order_d4t_pay", "2036-01-01");
    const due = inv.totalMinor;
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => recordManualPayment(mPlatform, { invoiceId: inv.id, amountMinor: due, method: "MANUAL", idempotencyKey: "d4t-mp-000001" })));
    void results;
    const rows = await prisma.billingPayment.count({ where: { idempotencyKey: "pay:d4t-mp-000001" } });
    const after = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    if (rows === 1 && after.amountPaidMinor === due) ok("concurrent identical manual payments apply once"); else bad("concurrent manual pay", `rows=${rows} paid=${after.amountPaidMinor}/${due}`);
  }
}

run().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
