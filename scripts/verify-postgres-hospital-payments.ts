/**
 * Week 5c — "pay your share" to the HOSPITAL's own gateway account
 * (docs/PATIENT_INSURANCE_DESIGN.md §6, §14), on an injected transport (the
 * Razorpay API is never called from a gate):
 *   - no configured, enabled gateway: PROVIDER_NOT_CONFIGURED, honestly;
 *   - configuring: TEST mode only (rzp_test_), the secrets only in the
 *     environment under the facility's secretRef (never stored, returned or
 *     in an event); only the facility's admins (paymentgateway.manage);
 *   - the order: the server's amount (the patient's share, less what they
 *     paid), created with THAT facility's key (the money goes to the
 *     hospital); unknown shares refused; another person's bill 404; an
 *     INSURANCE proxy may pay a member's, a proxy without it may not;
 *   - the webhook: a wrong signature, or one signed with another facility's
 *     secret, records nothing; the right one records the payment, allocates
 *     it to the invoice and marks the order PAID with its events; a replay,
 *     a wrong amount or an unknown order change nothing; payment.failed
 *     fails the order; afterwards nothing more is due;
 *   - the browser-smoke stub is refused on a production deployment.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-hospital-payments.ts
 */
import "./lib/gateBootstrap";
import { createHmac, randomBytes } from "node:crypto";
process.env.SMS_PROVIDER = "outbox";
process.env.EMAIL_PROVIDER = "outbox";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { getFacilityGateway, handleGatewayWebhook, payShare, setFacilityGateway, setGatewayTransportForTest } from "../src/lib/insurance/hospitalPayments";
import { insuranceStatus } from "../src/lib/insurance/status";
import { authorizeAccess } from "../src/lib/auth/authorize/engine";
import type { HttpRequest } from "../src/lib/billing/provider/http";
import { NOIDA, PUNE, drain, eventsOf, notFound, refused, reporter, sharer, staff, tag } from "./lib/shareFixture";
import { cardKeyForRun, issueBill } from "./lib/insuranceFixture";

const { report, done } = reporter();
const REF = `GATE${tag.toUpperCase().replace(/[^A-Z0-9]/g, "")}`.slice(0, 30);
const REF_N = `${REF}N`.slice(0, 31);
const KEY_SECRET = randomBytes(18).toString("hex"), HOOK_SECRET = randomBytes(18).toString("hex"), HOOK_N = randomBytes(18).toString("hex");
const KEY_ID = `rzp_test_${tag.replace(/[^A-Za-z0-9]/g, "")}AB`;

const sent: HttpRequest[] = [];
let n = 0;
setGatewayTransportForTest(async (req) => {
  sent.push(req);
  const b = JSON.parse(req.body ?? "{}") as { amount?: number; currency?: string; receipt?: string };
  n += 1;
  return { status: 200, body: JSON.stringify({ id: `order_gate${tag}${n}`, amount: b.amount, currency: b.currency, receipt: b.receipt, status: "created" }) };
});

const sign = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("hex");
const captured = (orderId: string, amount: number, payId: string) => JSON.stringify({ event: "payment.captured", created_at: Math.floor(Date.now() / 1000), payload: { payment: { entity: { id: payId, order_id: orderId, amount, status: "captured", method: "upi" } } } });

async function main() {
  registerAllConsumers();
  cardKeyForRun();
  const admin = await staff(PUNE, "HOSPITAL_ADMIN");
  const billing = await staff(PUNE, "BILLING_STAFF" as never);
  const P = await sharer();
  const inv = await issueBill({ encounterId: P.punEnc, patientId: P.pune, facilityId: PUNE, byUserId: billing.userId }, [["Consultation", 700], ["X-ray", 500]]);
  await drain();

  // 1. Nothing configured.
  report("No gateway: PROVIDER_NOT_CONFIGURED (honestly), no order", (await payShare({ userId: P.userId }, inv.id)).status === "PROVIDER_NOT_CONFIGURED" && (await prisma.patientPaymentOrder.count({ where: { invoiceId: inv.id } })) === 0);

  // 2. Configuring (the facility's own account).
  const pune = { userId: admin.userId, facilityId: PUNE };
  report("LIVE mode is refused (test mode only for now)", await refused(setFacilityGateway(pune, { keyId: KEY_ID, secretRef: REF, mode: "LIVE", enabled: true })));
  report("A live key id is refused", await refused(setFacilityGateway(pune, { keyId: "rzp_live_ABCDEF123", secretRef: REF, enabled: false })));
  report("Enabling before the secrets are in the environment is refused", await refused(setFacilityGateway(pune, { keyId: KEY_ID, secretRef: REF, enabled: true })));
  process.env[`RAZORPAY_KEY_SECRET__${REF}`] = KEY_SECRET;
  process.env[`RAZORPAY_WEBHOOK_SECRET__${REF}`] = HOOK_SECRET;
  const g = await setFacilityGateway(pune, { keyId: KEY_ID, secretRef: REF, enabled: true });
  const stored = await prisma.facilityPaymentGateway.findUniqueOrThrow({ where: { facilityId: PUNE } });
  report("Configured: TEST, enabled, the secrets present in the environment but never stored or returned",
    g.configured && g.mode === "TEST" && g.enabled && g.secretsPresent && !JSON.stringify(stored).includes(KEY_SECRET) && !JSON.stringify(await getFacilityGateway(PUNE)).includes(KEY_SECRET) && !JSON.stringify(await getFacilityGateway(PUNE)).includes(HOOK_SECRET));
  const gev = await eventsOf(stored.id, "FacilityPaymentGatewayChanged");
  report("…FacilityPaymentGatewayChanged, with no key or secret", gev.length >= 1 && gev.every((e) => !JSON.stringify(e.payload).includes(KEY_SECRET) && !JSON.stringify(e.payload).includes(KEY_ID)));
  const act = async (userId: string, facilityId: string) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { hospitalStaffProfile: true } });
    return authorizeAccess({ actor: { userId, role: u.role, staffId: u.hospitalStaffProfile?.id ?? null, staffStatus: u.hospitalStaffProfile?.status ?? null, facilityId, authAgeMs: 1_000 }, action: "paymentgateway.manage", resource: { type: "SECURITY", facilityId: PUNE } }, { skipAudit: true });
  };
  report("Only the facility's admins may configure it", (await act(admin.userId, PUNE)).decision === "ALLOW" && (await act(billing.userId, PUNE)).decision !== "ALLOW");

  // 3. The order.
  const due = 120_000;
  const o = await payShare({ userId: P.userId }, inv.id);
  if (o.status !== "READY") throw new Error("expected an order");
  const req = sent[sent.length - 1];
  report("An order for the server's amount (the share due), with the hospital's own key", o.amountMinor === due && JSON.parse(req.body!).amount === due && req.headers.Authorization === `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64")}` && o.keyId === KEY_ID && o.mode === "TEST");
  const order = await prisma.patientPaymentOrder.findUniqueOrThrow({ where: { id: o.orderId } });
  report("…recorded CREATED with PatientPaymentOrderChanged", order.status === "CREATED" && order.amountMinor === due && (await eventsOf(order.id, "PatientPaymentOrderChanged")).length === 1);
  report("Asking again reuses the open order", (await payShare({ userId: P.userId }, inv.id) as { orderId: string }).orderId === order.id);
  const other = await sharer();
  report("Someone else's bill: 404", await notFound(payShare({ userId: other.userId }, inv.id)));
  const ins = await sharer(), view = await sharer();
  await prisma.proxyGrant.create({ data: { memberPersonId: P.personId, proxyPersonId: ins.personId, basis: "MEMBER_CHOICE", permissions: ["INSURANCE"], categories: ["LABS"], status: "ACTIVE", grantedByPersonId: P.personId } });
  await prisma.proxyGrant.create({ data: { memberPersonId: P.personId, proxyPersonId: view.personId, basis: "MEMBER_CHOICE", permissions: ["VIEW"], categories: ["LABS"], status: "ACTIVE", grantedByPersonId: P.personId } });
  report("An INSURANCE proxy may pay the member's share; a proxy without it may not (404)", (await payShare({ userId: ins.userId, memberPersonId: P.personId }, inv.id)).status === "READY" && await notFound(payShare({ userId: view.userId, memberPersonId: P.personId }, inv.id)));

  // 4. The webhook.
  const body = captured(order.providerOrderRef, due, `pay_gate${tag}1`);
  const before = await prisma.payment.count({ where: { patientId: P.pune } });
  report("A wrong signature records nothing", (await handleGatewayWebhook(PUNE, body, "0".repeat(64))) === "INVALID_SIGNATURE" && (await prisma.payment.count({ where: { patientId: P.pune } })) === before);
  process.env[`RAZORPAY_KEY_SECRET__${REF_N}`] = randomBytes(12).toString("hex");
  process.env[`RAZORPAY_WEBHOOK_SECRET__${REF_N}`] = HOOK_N;
  await setFacilityGateway({ userId: (await staff(NOIDA, "HOSPITAL_ADMIN")).userId, facilityId: NOIDA }, { keyId: `${KEY_ID}N`, secretRef: REF_N, enabled: true });
  report("…nor one signed with another facility's secret", (await handleGatewayWebhook(PUNE, body, sign(body, HOOK_N))) === "INVALID_SIGNATURE" && (await prisma.payment.count({ where: { patientId: P.pune } })) === before);
  report("…nor this facility's event sent to another facility's webhook", (await handleGatewayWebhook(NOIDA, body, sign(body, HOOK_N))) === "UNKNOWN_ORDER");
  const bad = captured(order.providerOrderRef, due - 100, `pay_gate${tag}x`);
  report("A wrong amount changes nothing", (await handleGatewayWebhook(PUNE, bad, sign(bad, HOOK_SECRET))) === "AMOUNT_MISMATCH" && (await prisma.patientPaymentOrder.findUniqueOrThrow({ where: { id: order.id } })).status === "CREATED");
  const okv = await handleGatewayWebhook(PUNE, body, sign(body, HOOK_SECRET), `evt_${tag}_1`);
  const paid = await prisma.patientPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
  const pay = await prisma.payment.findUniqueOrThrow({ where: { id: paid.paymentId! } });
  report("Verified: the payment recorded to the hospital, allocated to the invoice, the order PAID", okv === "PAID" && paid.status === "PAID" && pay.amountMinor === due && pay.facilityId === PUNE && pay.method === "UPI"
    && (await prisma.paymentAllocation.count({ where: { paymentId: pay.id, invoiceId: inv.id, amountMinor: due } })) === 1 && (await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status === "PAID");
  report("…HospitalPaymentRecorded and PatientPaymentOrderChanged (PAID)", (await eventsOf(pay.id, "HospitalPaymentRecorded")).length === 1 && (await eventsOf(order.id, "PatientPaymentOrderChanged")).some((e) => (e.payload as { to?: string }).to === "PAID"));
  report("A replay changes nothing (one payment)", (await handleGatewayWebhook(PUNE, body, sign(body, HOOK_SECRET), `evt_${tag}_1`)) === "DUPLICATE" && (await prisma.payment.count({ where: { patientId: P.pune } })) === before + 1);
  const unk = captured("order_nope", 100, `pay_gate${tag}u`);
  report("An unknown order changes nothing", (await handleGatewayWebhook(PUNE, unk, sign(unk, HOOK_SECRET))) === "UNKNOWN_ORDER");
  const bill = (await insuranceStatus({ userId: P.userId })).visits.flatMap((x) => x.bills).find((b) => b.invoiceId === inv.id)!;
  report("Afterwards nothing more is due, and nothing to pay", bill.share.dueMinor === 0 && !bill.payable && (await refused(payShare({ userId: P.userId }, inv.id))));

  // payment.failed.
  const Q = await sharer();
  const inv2 = await issueBill({ encounterId: Q.punEnc, patientId: Q.pune, facilityId: PUNE, byUserId: billing.userId }, [["Consultation", 300]]);
  const o2 = await payShare({ userId: Q.userId }, inv2.id) as { orderId: string; providerOrderRef: string };
  const fbody = JSON.stringify({ event: "payment.failed", payload: { payment: { entity: { id: `pay_gate${tag}f`, order_id: o2.providerOrderRef, amount: 30_000, status: "failed", error_code: "BAD_REQUEST_ERROR" } } } });
  report("payment.failed: the order FAILED, no payment", (await handleGatewayWebhook(PUNE, fbody, sign(fbody, HOOK_SECRET))) === "FAILED" && (await prisma.patientPaymentOrder.findUniqueOrThrow({ where: { id: o2.orderId } })).status === "FAILED" && (await prisma.payment.count({ where: { patientId: Q.pune } })) === 0);

  // The smoke-run stub is never for production.
  setGatewayTransportForTest(null);
  process.env.HOSPITAL_GATEWAY_STUB = "1";
  process.env.VERCEL_ENV = "production";
  const R = await sharer();
  const inv3 = await issueBill({ encounterId: R.punEnc, patientId: R.pune, facilityId: PUNE, byUserId: billing.userId }, [["Consultation", 300]]);
  report("The browser-smoke stub is refused on a production deployment", await refused(payShare({ userId: R.userId }, inv3.id)));
  delete process.env.VERCEL_ENV;
  const st = await payShare({ userId: R.userId }, inv3.id);
  report("…and works in TEST mode elsewhere (order creation only)", st.status === "READY" && st.providerOrderRef.startsWith("order_stub"));
  delete process.env.HOSPITAL_GATEWAY_STUB;
  const audits = await prisma.auditEvent.findMany({ where: { type: { in: ["hospital.paymentGateway.configured", "hospital.payment.gatewayWebhook", "patient.payment.orderCreated"] }, createdAt: { gt: new Date(Date.now() - 3_600_000) } } });
  report("No secret in any audit row", audits.length > 0 && audits.every((a) => !JSON.stringify(a.detail).includes(KEY_SECRET) && !JSON.stringify(a.detail).includes(HOOK_SECRET)));

  await done();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
