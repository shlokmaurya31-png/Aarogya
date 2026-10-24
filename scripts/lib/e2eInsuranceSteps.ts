/**
 * Week 5c — the hospital's side of the insurance smoke (e2e/insurance.spec.ts),
 * run between browser steps through the real services, against the smoke
 * database only (the same guard as every gate):
 *   bill     the visit became an admission: a pre-authorization approved on
 *            the coverage the desk verified, discharge, the itemised bill
 *            (the worker drafts the claim);
 *   webhook  the hospital's gateway confirms the patient's payment: a
 *            payment.captured webhook signed with the facility's test secret,
 *            POSTed to the app (as Razorpay would);
 *   settle   the claim submitted, approved and settled.
 */
import "./e2eGuard";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { prisma } from "../../src/lib/db";
import { decidePreAuth, requestPreAuth } from "../../src/lib/hospital/billing/preauth";
import { recordClaimDecision, settleClaim, submitClaim } from "../../src/lib/hospital/billing/claims";
import { initiateDischarge } from "../../src/lib/hospital/admission";
import type { E2eFixture } from "./e2eFixture";
import { PUNE } from "./e2eFixture";
import { admissionFor, issueBill } from "./insuranceFixture";

async function main() {
  const [cmd] = process.argv.slice(2);
  const f = JSON.parse(readFileSync(process.env.E2E_FIXTURE!, "utf8")) as E2eFixture;
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: f.desk.email }, include: { hospitalStaffProfile: true } });
  const by = admin.id;
  if (cmd === "bill") {
    const cov = await prisma.patientCoverage.findFirstOrThrow({ where: { patientId: f.patient.patientId, status: "ACTIVE", sourceCardId: { not: null } } });
    const A = await admissionFor(f.patient.patientId, PUNE, admin.hospitalStaffProfile!.id);
    const pa = await prisma.$transaction((t) => requestPreAuth(t, { coverageId: cov.id, encounterId: A.encounterId, requestedAmountMinor: 500_000, requestedByUserId: by }));
    await prisma.$transaction((t) => decidePreAuth(t, pa.id, { status: "APPROVED", approvedAmountMinor: 400_000, byUserId: by }));
    await initiateDischarge(A.admissionId, by, admin.hospitalStaffProfile!.id);
    const inv = await issueBill({ encounterId: A.encounterId, patientId: f.patient.patientId, facilityId: PUNE, byUserId: by }, [["Room (3 days)", 3000], ["Surgery", 1800], ["Medicines", 400]]);
    console.log(JSON.stringify({ invoiceId: inv.id }));
  } else if (cmd === "webhook") {
    const order = await prisma.patientPaymentOrder.findFirstOrThrow({ where: { patientId: f.patient.patientId, status: "CREATED" }, orderBy: { createdAt: "desc" } });
    const body = JSON.stringify({ event: "payment.captured", created_at: Math.floor(Date.now() / 1000), payload: { payment: { entity: { id: `pay_smoke${f.tag}`, order_id: order.providerOrderRef, amount: order.amountMinor, status: "captured", method: "upi" } } } });
    const signature = createHmac("sha256", process.env[`RAZORPAY_WEBHOOK_SECRET__${f.gatewaySecretRef}`]!).update(body).digest("hex");
    const r = await fetch(`${process.env.E2E_BASE_URL}/api/payments/hospital/${PUNE}/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Razorpay-Signature": signature, "X-Razorpay-Event-Id": `evt_smoke_${f.tag}` }, body });
    console.log(JSON.stringify({ status: r.status, body: await r.json() }));
    if (r.status !== 200) process.exit(1);
  } else if (cmd === "settle") {
    const claim = await prisma.claim.findFirstOrThrow({ where: { invoice: { patientId: f.patient.patientId } }, orderBy: { createdAt: "desc" } });
    await prisma.$transaction((t) => submitClaim(t, claim.id, { byUserId: by }));
    await prisma.$transaction((t) => recordClaimDecision(t, claim.id, { status: "UNDER_REVIEW", byUserId: by }));
    await prisma.$transaction((t) => recordClaimDecision(t, claim.id, { status: "APPROVED", approvedAmountMinor: 400_000, byUserId: by }));
    await prisma.$transaction((t) => settleClaim(t, claim.id, { settledAmountMinor: 400_000, byUserId: by }));
    console.log(JSON.stringify({ claimId: claim.id }));
  } else throw new Error(`unknown step ${cmd}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
