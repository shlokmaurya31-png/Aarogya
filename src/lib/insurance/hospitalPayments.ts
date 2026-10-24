import { randomBytes } from "node:crypto";
import type { FacilityPaymentGateway, PatientPaymentOrder, PaymentMethod, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { RazorpayBillingProvider } from "@/lib/billing/provider/razorpay";
import { fetchTransport, type HttpTransport } from "@/lib/billing/provider/http";
import { allocatePayment, recordPayment } from "@/lib/hospital/billing/payments";
import { insurancePerson, patientShare, personPatientIds } from "./status";

/**
 * Week 5c — "pay your share" (docs/PATIENT_INSURANCE_DESIGN.md §6, §14).
 *
 *   - The money goes to the HOSPITAL's own payment-gateway account: each
 *     facility configures its own Razorpay account (FacilityPaymentGateway).
 *     Aarogya is never the merchant and never holds the money.
 *   - Only the public key id is stored. The key secret and the webhook secret
 *     come from the environment under the facility's secretRef
 *     (RAZORPAY_KEY_SECRET__<REF>, RAZORPAY_WEBHOOK_SECRET__<REF>); they are
 *     never stored, returned or logged.
 *   - TEST mode only for now (a rzp_test_ key); LIVE is refused until the
 *     pre-launch item is done.
 *   - The amount is the server's: the patient's share of the invoice
 *     (status.ts patientShare), less what they already paid. The patient pays
 *     their own share, or a household proxy with INSURANCE pays a member's.
 *   - A payment is recorded only from the facility's verified webhook
 *     (payment.captured, the signature checked with that facility's secret,
 *     the amount matching the order): recordPayment + allocatePayment to the
 *     invoice and the order PAID, in one transaction (HospitalPaymentRecorded,
 *     PatientPaymentOrderChanged). Never from the browser.
 *   - Without a configured, enabled gateway: PROVIDER_NOT_CONFIGURED, honestly.
 */
type Tx = Prisma.TransactionClient;
const SECRET_REF = /^[A-Z0-9_]{3,40}$/;

// ── Configuration (the facility's admin) ────────────────────────────────

export function gatewaySecrets(ref: string, env: Record<string, string | undefined> = process.env) {
  const keySecret = env[`RAZORPAY_KEY_SECRET__${ref}`];
  const webhookSecret = env[`RAZORPAY_WEBHOOK_SECRET__${ref}`];
  return keySecret && webhookSecret ? { keySecret, webhookSecret } : null;
}

/** What admins see: never a secret, only whether the environment has them. */
export function gatewayView(g: FacilityPaymentGateway | null) {
  if (!g) return { configured: false as const };
  return { configured: true as const, id: g.id, provider: g.provider, mode: g.mode, keyId: g.keyId, secretRef: g.secretRef, enabled: g.enabled, secretsPresent: !!gatewaySecrets(g.secretRef) };
}

export async function getFacilityGateway(facilityId: string) {
  return gatewayView(await prisma.facilityPaymentGateway.findUnique({ where: { facilityId } }));
}

export async function setFacilityGateway(admin: { userId: string; facilityId: string }, body: { keyId?: unknown; secretRef?: unknown; mode?: unknown; enabled?: unknown }) {
  const mode = body.mode ?? "TEST";
  if (mode === "LIVE") throw new ConflictError("Live payments aren't available yet: use a Razorpay test-mode key (pre-launch checklist).");
  if (mode !== "TEST") throw new BadRequestError("mode must be TEST.");
  const keyId = typeof body.keyId === "string" ? body.keyId.trim() : "";
  if (!/^rzp_test_[A-Za-z0-9]{6,32}$/.test(keyId)) throw new BadRequestError("A Razorpay test-mode key id starts with rzp_test_.");
  const secretRef = typeof body.secretRef === "string" ? body.secretRef.trim().toUpperCase() : "";
  if (!SECRET_REF.test(secretRef)) throw new BadRequestError("secretRef: 3 to 40 capital letters, digits or underscores (it names the environment variables holding this facility's secrets).");
  const enabled = body.enabled === true;
  if (enabled && !gatewaySecrets(secretRef)) throw new ConflictError(`Set RAZORPAY_KEY_SECRET__${secretRef} and RAZORPAY_WEBHOOK_SECRET__${secretRef} in the environment before enabling.`);
  const g = await prisma.$transaction(async (tx) => {
    const row = await tx.facilityPaymentGateway.upsert({
      where: { facilityId: admin.facilityId },
      create: { facilityId: admin.facilityId, mode: "TEST", keyId, secretRef, enabled, configuredByUserId: admin.userId },
      update: { mode: "TEST", keyId, secretRef, enabled, configuredByUserId: admin.userId, version: { increment: 1 } },
    });
    await emitFacilityEvent(tx, { type: "FacilityPaymentGatewayChanged", aggregateId: row.id, facilityId: row.facilityId, actorUserId: admin.userId, payload: { gatewayId: row.id, provider: "RAZORPAY", mode: row.mode, enabled: row.enabled } });
    return row;
  });
  await recordAuditEvent("hospital.paymentGateway.configured", admin.userId, { gatewayId: g.id, mode: g.mode, enabled: g.enabled }, { facilityId: admin.facilityId });
  return gatewayView(g);
}

// ── The adapter for one facility ────────────────────────────────────────

let transportOverride: HttpTransport | null = null;
/** Gates only: an injected transport (the Razorpay API is never called from a gate). */
export function setGatewayTransportForTest(t: HttpTransport | null) { transportOverride = t; }

/**
 * TEST-mode stub of the Razorpay Orders API for the browser smoke run, where
 * no Razorpay test account exists: it answers order creation only. Allowed
 * only with HOSPITAL_GATEWAY_STUB=1, a TEST-mode gateway, and never on a
 * production deployment. The payment itself still arrives only as a webhook
 * signed with the facility's webhook secret.
 */
const stubTransport: HttpTransport = async (req) => {
  if (req.method === "POST" && req.url.endsWith("/orders")) {
    const b = JSON.parse(req.body ?? "{}") as { amount?: number; currency?: string; receipt?: string };
    return { status: 200, body: JSON.stringify({ id: `order_stub${randomBytes(6).toString("hex")}`, amount: b.amount, currency: b.currency, receipt: b.receipt, status: "created" }) };
  }
  return { status: 404, body: JSON.stringify({ error: { code: "STUB", description: "Only order creation is stubbed." } }) };
};

function transportFor(g: FacilityPaymentGateway): HttpTransport {
  if (transportOverride) return transportOverride;
  if (process.env.HOSPITAL_GATEWAY_STUB === "1") {
    if (g.mode !== "TEST" || process.env.VERCEL_ENV === "production") throw new ConflictError("The test gateway stub is refused here.");
    return stubTransport;
  }
  return fetchTransport;
}

async function providerFor(facilityId: string): Promise<{ g: FacilityPaymentGateway; provider: RazorpayBillingProvider } | null> {
  const g = await prisma.facilityPaymentGateway.findUnique({ where: { facilityId } });
  if (!g || !g.enabled || g.mode !== "TEST") return null;
  const s = gatewaySecrets(g.secretRef);
  if (!s) return null;
  const provider = new RazorpayBillingProvider({ keyId: g.keyId, keySecret: s.keySecret, webhookSecret: s.webhookSecret, baseUrl: process.env.RAZORPAY_BASE_URL || "https://api.razorpay.com/v1", webhookToleranceSeconds: 300 }, transportFor(g));
  return { g, provider };
}

// ── The patient pays their share ────────────────────────────────────────

async function orderEventTx(tx: Tx, o: PatientPaymentOrder, from: "NONE" | "CREATED", to: "CREATED" | "PAID" | "FAILED", actorUserId: string | null) {
  await emitFacilityEvent(tx, {
    type: "PatientPaymentOrderChanged", aggregateId: o.id, facilityId: o.facilityId, actorUserId,
    payload: { orderId: o.id, invoiceId: o.invoiceId, patientId: o.patientId, from, to, amountMinor: o.amountMinor, currency: o.currency, mode: o.mode, ...(o.paymentId ? { paymentId: o.paymentId } : {}) },
  });
}

/** The share still due on one of the person's invoices (the server's amount), or 404 / nothing due. */
export async function shareDue(personId: string, invoiceId: string) {
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { payer: { select: { type: true } }, claim: true, encounter: { select: { preAuthorizations: { orderBy: { requestedAt: "desc" }, take: 1 } } } } });
  if (!inv || !(await personPatientIds(personId)).includes(inv.patientId)) throw new NotFoundError();
  const paid = (await prisma.paymentAllocation.findMany({ where: { invoiceId: inv.id, payment: { method: { not: "INSURANCE_SETTLEMENT" }, status: "RECEIVED" } }, select: { amountMinor: true } })).reduce((s, r) => s + r.amountMinor, 0);
  const share = patientShare(inv, inv.payer?.type === "CASH", inv.claim, inv.encounter.preAuthorizations[0] ?? null, paid);
  // Never more than the invoice still has outstanding.
  return { inv, share, due: Math.min(share.dueMinor, Math.max(0, inv.totalMinor - inv.allocatedMinor)) };
}

/**
 * Starts paying the share: an order with the facility's own gateway for the
 * server's amount. The browser opens the gateway's checkout with the public
 * key id and the order; nothing is recorded until the verified webhook.
 */
export async function payShare(a: { userId: string; memberPersonId?: string }, invoiceId: string) {
  const personId = await insurancePerson(a);
  const { inv, share, due } = await shareDue(personId, invoiceId);
  if (!share.known) throw new ConflictError("Your share isn't known yet: you'll be told when it is.");
  if (due <= 0) throw new BadRequestError("Nothing is due from you on this bill.");
  const p = await providerFor(inv.facilityId);
  if (!p) return { status: "PROVIDER_NOT_CONFIGURED" as const, amountMinor: due, currency: inv.currency };
  const open = await prisma.patientPaymentOrder.findFirst({ where: { invoiceId: inv.id, status: "CREATED", amountMinor: due, createdAt: { gt: new Date(Date.now() - 30 * 60_000) } } });
  if (open) return { status: "READY" as const, orderId: open.id, providerOrderRef: open.providerOrderRef, keyId: p.g.keyId, amountMinor: open.amountMinor, currency: open.currency, mode: open.mode };
  const n = await prisma.patientPaymentOrder.count({ where: { invoiceId: inv.id } });
  const created = await p.provider.createPayment({ amountMinor: due, currency: inv.currency, idempotencyKey: `share-${inv.id}-${n + 1}` });
  if (!created.providerRequestRef) throw new ConflictError("The payment couldn't be started. Try again.");
  const order = await prisma.$transaction(async (tx) => {
    const o = await tx.patientPaymentOrder.create({ data: { facilityId: inv.facilityId, invoiceId: inv.id, patientId: inv.patientId, amountMinor: due, currency: inv.currency, mode: p.g.mode, providerOrderRef: created.providerRequestRef!, createdByUserId: a.userId } });
    await orderEventTx(tx, o, "NONE", "CREATED", a.userId);
    if (a.memberPersonId) await tx.personAccessLogEntry.create({ data: { personId, kind: "PROXY_ACTION", actorUserId: a.userId, detail: { via: "PROXY", action: "PAY_SHARE", invoiceId: inv.id, orderId: o.id } } });
    return o;
  });
  await recordAuditEvent("patient.payment.orderCreated", a.userId, { orderId: order.id, invoiceId: inv.id, amountMinor: due }, { facilityId: inv.facilityId, patientId: inv.patientId });
  return { status: "READY" as const, orderId: order.id, providerOrderRef: order.providerOrderRef, keyId: p.g.keyId, amountMinor: order.amountMinor, currency: order.currency, mode: order.mode };
}

export async function orderStatus(a: { userId: string; memberPersonId?: string }, orderId: string) {
  const personId = await insurancePerson(a);
  const o = await prisma.patientPaymentOrder.findUnique({ where: { id: orderId } });
  if (!o || !(await personPatientIds(personId)).includes(o.patientId)) throw new NotFoundError();
  return { orderId: o.id, status: o.status, amountMinor: o.amountMinor, paidAt: o.paidAt?.toISOString() ?? null };
}

const METHOD: Record<string, PaymentMethod> = { upi: "UPI", card: "CARD", netbanking: "NETBANKING" };

/**
 * The facility's gateway webhook. The signature is checked with this
 * facility's webhook secret before anything is read; each event is handled
 * once (FacilityGatewayWebhook). payment.captured with the order's exact
 * amount pays the order: the payment recorded and allocated to the invoice.
 * Returns a closed outcome (the route always answers 200 to a verified call).
 */
export async function handleGatewayWebhook(facilityId: string, rawBody: string, signature: string, eventId?: string): Promise<"INVALID_SIGNATURE" | "NOT_CONFIGURED" | "DUPLICATE" | "IGNORED" | "UNKNOWN_ORDER" | "AMOUNT_MISMATCH" | "PAID" | "FAILED"> {
  const p = await providerFor(facilityId);
  if (!p) return "NOT_CONFIGURED";
  if (!p.provider.verifyWebhook({ payload: rawBody, signature })) return "INVALID_SIGNATURE";
  let ev;
  try { ev = p.provider.parseWebhook(rawBody, eventId); } catch { return "IGNORED"; }
  const raw = JSON.parse(rawBody) as { payload?: { payment?: { entity?: { method?: string } } } };
  const outcome = await prisma.$transaction(async (tx) => {
    const seen = await tx.facilityGatewayWebhook.findUnique({ where: { facilityId_externalEventId: { facilityId, externalEventId: ev.externalEventId } } });
    if (seen) return "DUPLICATE" as const;
    const record = (o: string) => tx.facilityGatewayWebhook.create({ data: { facilityId, externalEventId: ev.externalEventId, eventType: ev.eventType, outcome: o } });
    if (ev.eventType !== "payment.captured" && ev.eventType !== "payment.failed") { await record("IGNORED"); return "IGNORED" as const; }
    const order = ev.providerResourceRef ? await tx.patientPaymentOrder.findUnique({ where: { providerOrderRef: ev.providerResourceRef } }) : null;
    if (!order || order.facilityId !== facilityId) { await record("UNKNOWN_ORDER"); return "UNKNOWN_ORDER" as const; }
    if (order.status !== "CREATED") { await record("DUPLICATE"); return "DUPLICATE" as const; }
    if (ev.eventType === "payment.failed") {
      const r = await tx.patientPaymentOrder.updateMany({ where: { id: order.id, status: "CREATED" }, data: { status: "FAILED", version: { increment: 1 } } });
      if (r.count === 1) await orderEventTx(tx, { ...order, status: "FAILED" }, "CREATED", "FAILED", null);
      await record("FAILED");
      return "FAILED" as const;
    }
    if (ev.paymentStatus !== "succeeded" || ev.amountMinor !== order.amountMinor || !ev.providerPaymentRef) { await record("AMOUNT_MISMATCH"); return "AMOUNT_MISMATCH" as const; }
    const inv = await tx.invoice.findUniqueOrThrow({ where: { id: order.invoiceId }, select: { encounterId: true } });
    const { payment } = await recordPayment(tx, {
      encounterId: inv.encounterId, patientId: order.patientId, facilityId, amountMinor: order.amountMinor, method: METHOD[raw.payload?.payment?.entity?.method ?? ""] ?? "UPI",
      idempotencyKey: `gateway:${ev.providerPaymentRef}`, referenceNo: ev.providerPaymentRef, receivedByUserId: order.createdByUserId,
    });
    await allocatePayment(tx, { paymentId: payment.id, invoiceId: order.invoiceId, amountMinor: order.amountMinor, allocatedByUserId: order.createdByUserId });
    const r = await tx.patientPaymentOrder.updateMany({ where: { id: order.id, status: "CREATED" }, data: { status: "PAID", paymentId: payment.id, providerPaymentRef: ev.providerPaymentRef, paidAt: new Date(), version: { increment: 1 } } });
    if (r.count !== 1) throw new ConflictError("The order changed concurrently.");
    await orderEventTx(tx, { ...order, status: "PAID", paymentId: payment.id }, "CREATED", "PAID", null);
    await record("PAID");
    return "PAID" as const;
  });
  await recordAuditEvent("hospital.payment.gatewayWebhook", null, { outcome, eventType: ev.eventType }, { facilityId });
  return outcome;
}
