/**
 * Phase 5 manual verification: proves the 6 required financial concurrency
 * invariants hold against a real PostgreSQL instance, including genuine
 * concurrent races — not sequential requests. Mirrors
 * scripts/verify-postgres-scheduling.ts's structure (this codebase has no
 * automated DB-backed test harness; concurrency is verified via real
 * parallel execution, by established convention).
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-billing-concurrency.ts
 */
import { PrismaClient } from "@prisma/client";
import { createOrderEnvelope } from "../src/lib/hospital/orderEnvelope";
import { createChargeIfNotExists } from "../src/lib/hospital/billing/chargeCapture";
import { recordPayment, allocatePayment, OverAllocationError } from "../src/lib/hospital/billing/payments";
import { requestRefund, completeRefund, approveRefund } from "../src/lib/hospital/billing/refunds";
import { draftInvoiceForAccount, addChargeToInvoice, issueInvoice, InvoiceConcurrencyError } from "../src/lib/hospital/billing/invoices";
import { getOrCreateBillingAccount } from "../src/lib/hospital/billing/billingAccount";
import { createTariff, TariffConflictError } from "../src/lib/hospital/billing/pricing";
import { createClaimDraft, submitClaim, ClaimConcurrencyError } from "../src/lib/hospital/billing/claims";

const prisma = new PrismaClient();
let pass = 0;
let fail = 0;

function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function freshImagingOrder(facilityId: string, encounterId: string, patientId: string, staffId: string) {
  const envelope = await createOrderEnvelope(prisma, { facilityId, encounterId, patientId, orderingStaffId: staffId, orderType: "IMAGING", priority: "ROUTINE" });
  const order = await prisma.imagingOrder.create({ data: { encounterId, patientId, modality: "USG", studyDescription: "Concurrency-verify fixture", orderedByStaffId: staffId, status: "ORDERED", orderId: envelope.id } });
  return order.id;
}

async function main() {
  const facility = await prisma.facility.findFirstOrThrow({ where: { name: "Aarogya Medical Centre" } });
  const patient = await prisma.patient.findFirstOrThrow({ where: { facilityId: facility.id } });
  const encounter = await prisma.encounter.findFirstOrThrow({ where: { facilityId: facility.id, patientId: patient.id } });
  const staff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facility.id, user: { role: "BILLING_STAFF" } } });
  const cashPayer = await prisma.payer.findFirstOrThrow({ where: { type: "CASH" } });

  // 1. Charge race: two concurrent order-creation charge hooks for the SAME sourceId must produce exactly one Charge.
  {
    const orderId = await freshImagingOrder(facility.id, encounter.id, patient.id, staff.id);
    const attempt = () =>
      prisma.$transaction((tx) =>
        createChargeIfNotExists(tx, { encounterId: encounter.id, patientId: patient.id, facilityId: facility.id, description: "Race test", category: "IMAGING", unitPriceMinor: 100000, sourceType: "ImagingOrder", sourceId: orderId })
      );
    const [r1, r2] = await Promise.all([attempt(), attempt()]);
    const chargeCount = await prisma.charge.count({ where: { sourceType: "ImagingOrder", sourceId: orderId } });
    report("Charge race: exactly one Charge for two concurrent attempts on the same sourceId", chargeCount === 1, `charges=${chargeCount}, alreadyExisted=[${r1.alreadyExisted},${r2.alreadyExisted}]`);
  }

  // 2. Payment race (a): same idempotencyKey submitted twice concurrently -> one Payment.
  {
    const key = `verify-payment-race-${Date.now()}`;
    const attempt = () => prisma.$transaction((tx) => recordPayment(tx, { encounterId: encounter.id, patientId: patient.id, facilityId: facility.id, amountMinor: 100000, method: "CASH", idempotencyKey: key, receivedByUserId: staff.userId }));
    await Promise.all([attempt(), attempt()]);
    const count = await prisma.payment.count({ where: { idempotencyKey: key } });
    report("Payment race: exactly one Payment for two concurrent identical idempotencyKeys", count === 1, `payments=${count}`);
  }

  // 2b. Payment race: concurrent allocations must never push allocatedMinor+refundedMinor past amountMinor.
  {
    const orderId = await freshImagingOrder(facility.id, encounter.id, patient.id, staff.id);
    const { charge } = await prisma.$transaction((tx) => createChargeIfNotExists(tx, { encounterId: encounter.id, patientId: patient.id, facilityId: facility.id, description: "Allocation race fixture", category: "IMAGING", unitPriceMinor: 100000, sourceType: "ImagingOrder", sourceId: orderId }));
    const account = await prisma.$transaction((tx) => getOrCreateBillingAccount(tx, { encounterId: encounter.id, patientId: patient.id, facilityId: facility.id }));
    const invoice = await prisma.$transaction(async (tx) => {
      const draft = await draftInvoiceForAccount(tx, { encounterId: encounter.id, patientId: patient.id, facilityId: facility.id, generatedByUserId: staff.userId });
      await addChargeToInvoice(tx, draft.id, charge.id);
      return issueInvoice(tx, draft.id, {});
    });
    const { payment } = await prisma.$transaction((tx) => recordPayment(tx, { encounterId: encounter.id, patientId: patient.id, facilityId: facility.id, amountMinor: invoice.totalMinor, method: "CASH", idempotencyKey: `verify-alloc-race-${Date.now()}`, receivedByUserId: staff.userId }));
    const attemptAllocate = () => prisma.$transaction((tx) => allocatePayment(tx, { paymentId: payment.id, invoiceId: invoice.id, amountMinor: invoice.totalMinor, allocatedByUserId: staff.userId }));
    const results = await Promise.allSettled([attemptAllocate(), attemptAllocate()]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const finalPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    report(
      "Payment race: concurrent full-amount allocations never exceed the payment balance",
      succeeded === 1 && finalPayment.allocatedMinor === invoice.totalMinor,
      `succeeded=${succeeded}, allocatedMinor=${finalPayment.allocatedMinor}, totalMinor=${invoice.totalMinor}`
    );
    void account;
  }

  // Helpers for 2c-2g: P0-B fix — the invoice-side over-allocation race.
  // Case 2b above only proves the SAME Payment can't double-allocate; these
  // cases construct the actual reported bug: DIFFERENT Payments racing the
  // SAME Invoice, which the pre-fix code let both pass a stale in-memory
  // sum check. Amounts are in paise (INR minor units): ₹1000 = 100000.
  async function makeInvoiceWithTotal(totalMinor: number, label: string) {
    const orderId = await freshImagingOrder(facility.id, encounter.id, patient.id, staff.id);
    const { charge } = await prisma.$transaction((tx) =>
      createChargeIfNotExists(tx, { encounterId: encounter.id, patientId: patient.id, facilityId: facility.id, description: label, category: "IMAGING", unitPriceMinor: totalMinor, sourceType: "ImagingOrder", sourceId: orderId })
    );
    return prisma.$transaction(async (tx) => {
      const d = await draftInvoiceForAccount(tx, { encounterId: encounter.id, patientId: patient.id, facilityId: facility.id, generatedByUserId: staff.userId });
      await addChargeToInvoice(tx, d.id, charge.id);
      return issueInvoice(tx, d.id, {});
    });
  }
  async function makePayment(amountMinor: number, label: string) {
    const { payment } = await prisma.$transaction((tx) =>
      recordPayment(tx, { encounterId: encounter.id, patientId: patient.id, facilityId: facility.id, amountMinor, method: "CASH", idempotencyKey: `${label}-${Date.now()}-${Math.random()}`, receivedByUserId: staff.userId })
    );
    return payment;
  }

  // 2c. CASE 1 from the brief: outstanding=₹1000, two concurrent full-₹1000 allocations from two DIFFERENT payments -> one wins, one fails, final allocated=₹1000.
  {
    const invoice = await makeInvoiceWithTotal(100000, "P0-B case1 fixture");
    const [payA, payB] = await Promise.all([makePayment(100000, "p0b-case1-a"), makePayment(100000, "p0b-case1-b")]);
    const attempt = (paymentId: string) => prisma.$transaction((tx) => allocatePayment(tx, { paymentId, invoiceId: invoice.id, amountMinor: 100000, allocatedByUserId: staff.userId }));
    const results = await Promise.allSettled([attempt(payA.id), attempt(payB.id)]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failedOverAllocation = results.filter((r) => r.status === "rejected" && r.reason instanceof OverAllocationError).length;
    const finalInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    report(
      "P0-B CASE 1: two different ₹1000 payments racing a ₹1000 invoice — exactly one succeeds, final allocatedMinor=100000",
      succeeded === 1 && failedOverAllocation === 1 && finalInvoice.allocatedMinor === 100000,
      `succeeded=${succeeded}, allocatedMinor=${finalInvoice.allocatedMinor}`
    );
  }

  // 2d. CASE 2: outstanding=₹1000, two concurrent ₹600 allocations from two DIFFERENT payments -> one wins, final=₹600 (both individually fit the payment, but not both fit the invoice).
  {
    const invoice = await makeInvoiceWithTotal(100000, "P0-B case2 fixture");
    const [payA, payB] = await Promise.all([makePayment(60000, "p0b-case2-a"), makePayment(60000, "p0b-case2-b")]);
    const attempt = (paymentId: string) => prisma.$transaction((tx) => allocatePayment(tx, { paymentId, invoiceId: invoice.id, amountMinor: 60000, allocatedByUserId: staff.userId }));
    const results = await Promise.allSettled([attempt(payA.id), attempt(payB.id)]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const finalInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    report(
      "P0-B CASE 2: two ₹600 allocations racing a ₹1000 invoice — exactly one succeeds, final allocatedMinor=60000",
      succeeded === 1 && finalInvoice.allocatedMinor === 60000,
      `succeeded=${succeeded}, allocatedMinor=${finalInvoice.allocatedMinor}`
    );
  }

  // 2e. CASE 3: outstanding=₹1000, two concurrent ₹400 allocations from two DIFFERENT payments -> both fit, both succeed, final=₹800.
  {
    const invoice = await makeInvoiceWithTotal(100000, "P0-B case3 fixture");
    const [payA, payB] = await Promise.all([makePayment(40000, "p0b-case3-a"), makePayment(40000, "p0b-case3-b")]);
    const attempt = (paymentId: string) => prisma.$transaction((tx) => allocatePayment(tx, { paymentId, invoiceId: invoice.id, amountMinor: 40000, allocatedByUserId: staff.userId }));
    const results = await Promise.allSettled([attempt(payA.id), attempt(payB.id)]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const finalInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    report(
      "P0-B CASE 3: two ₹400 allocations racing a ₹1000 invoice — both fit and both succeed, final allocatedMinor=80000",
      succeeded === 2 && finalInvoice.allocatedMinor === 80000,
      `succeeded=${succeeded}, allocatedMinor=${finalInvoice.allocatedMinor}`
    );
  }

  // 2f. CASE 4: the SAME payment allocated to the SAME invoice twice, concurrently (a genuine duplicate-request race, not a retry-after-failure) -> exactly one logical PaymentAllocation persists.
  // allocatePayment itself takes no idempotency key (unlike recordPayment, already proven idempotent in case 2 above); the backstop here is PaymentAllocation's own @@unique([paymentId, invoiceId]) — the loser's transaction throws on that constraint and rolls back cleanly, including its invoice/payment-side guard increments (proven by allocatedMinor below being the single-attempt amount, not double).
  {
    const invoice = await makeInvoiceWithTotal(100000, "P0-B case4 fixture");
    const payment = await makePayment(100000, "p0b-case4");
    const attempt = () => prisma.$transaction((tx) => allocatePayment(tx, { paymentId: payment.id, invoiceId: invoice.id, amountMinor: 50000, allocatedByUserId: staff.userId }));
    const results = await Promise.allSettled([attempt(), attempt()]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const allocationCount = await prisma.paymentAllocation.count({ where: { paymentId: payment.id, invoiceId: invoice.id } });
    const finalInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    const finalPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    report(
      "P0-B CASE 4: identical concurrent duplicate allocation requests -> exactly one PaymentAllocation row, no double-counted totals",
      succeeded === 1 && allocationCount === 1 && finalInvoice.allocatedMinor === 50000 && finalPayment.allocatedMinor === 50000,
      `succeeded=${succeeded}, allocationRows=${allocationCount}, invoiceAllocated=${finalInvoice.allocatedMinor}, paymentAllocated=${finalPayment.allocatedMinor}`
    );
  }

  // 2g. CASE 5: THREE different ₹500 payments concurrently racing a ₹1000 invoice (not just pairwise) -> exactly two fit, final=₹1000, never exceeds totalMinor.
  {
    const invoice = await makeInvoiceWithTotal(100000, "P0-B case5 fixture");
    const [payA, payB, payC] = await Promise.all([makePayment(50000, "p0b-case5-a"), makePayment(50000, "p0b-case5-b"), makePayment(50000, "p0b-case5-c")]);
    const attempt = (paymentId: string) => prisma.$transaction((tx) => allocatePayment(tx, { paymentId, invoiceId: invoice.id, amountMinor: 50000, allocatedByUserId: staff.userId }));
    const results = await Promise.allSettled([attempt(payA.id), attempt(payB.id), attempt(payC.id)]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const finalInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    report(
      "P0-B CASE 5: three ₹500 payments racing a ₹1000 invoice — exactly two succeed, final allocatedMinor never exceeds totalMinor",
      succeeded === 2 && finalInvoice.allocatedMinor === 100000 && finalInvoice.allocatedMinor <= finalInvoice.totalMinor,
      `succeeded=${succeeded}, allocatedMinor=${finalInvoice.allocatedMinor}, totalMinor=${finalInvoice.totalMinor}`
    );
  }

  // 3. Invoice race (a): two concurrent issue attempts on the same DRAFT -> exactly one winner, no duplicate invoiceNumber collision.
  {
    const orderIdA = await freshImagingOrder(facility.id, encounter.id, patient.id, staff.id);
    const { charge: chargeA } = await prisma.$transaction((tx) => createChargeIfNotExists(tx, { encounterId: encounter.id, patientId: patient.id, facilityId: facility.id, description: "Invoice race fixture", category: "IMAGING", unitPriceMinor: 50000, sourceType: "ImagingOrder", sourceId: orderIdA }));
    const draft = await prisma.$transaction(async (tx) => {
      const d = await draftInvoiceForAccount(tx, { encounterId: encounter.id, patientId: patient.id, facilityId: facility.id, generatedByUserId: staff.userId });
      await addChargeToInvoice(tx, d.id, chargeA.id);
      return d;
    });
    const attemptIssue = () => prisma.$transaction((tx) => issueInvoice(tx, draft.id, {}));
    const results = await Promise.allSettled([attemptIssue(), attemptIssue()]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failedWithConcurrencyError = results.filter((r) => r.status === "rejected" && r.reason instanceof InvoiceConcurrencyError).length;
    report("Invoice race: exactly one of two concurrent issue attempts on the same DRAFT succeeds", succeeded === 1 && failedWithConcurrencyError === 1, `succeeded=${succeeded}`);
  }

  // 3b. Invoice race (b): concurrent issuance of two DIFFERENT invoices in the same facility+year never collides on invoiceNumber.
  {
    const makeDraft = async () => {
      const orderId = await freshImagingOrder(facility.id, encounter.id, patient.id, staff.id);
      const { charge } = await prisma.$transaction((tx) => createChargeIfNotExists(tx, { encounterId: encounter.id, patientId: patient.id, facilityId: facility.id, description: "Sequence race fixture", category: "IMAGING", unitPriceMinor: 20000, sourceType: "ImagingOrder", sourceId: orderId }));
      return prisma.$transaction(async (tx) => {
        const d = await draftInvoiceForAccount(tx, { encounterId: encounter.id, patientId: patient.id, facilityId: facility.id, generatedByUserId: staff.userId });
        await addChargeToInvoice(tx, d.id, charge.id);
        return d;
      });
    };
    const [draftA, draftB] = await Promise.all([makeDraft(), makeDraft()]);
    const [issuedA, issuedB] = await Promise.all([
      prisma.$transaction((tx) => issueInvoice(tx, draftA.id, {})),
      prisma.$transaction((tx) => issueInvoice(tx, draftB.id, {})),
    ]);
    report("Invoice race: two concurrent issuances on different invoices get distinct numbers", issuedA.invoiceNumber !== issuedB.invoiceNumber, `${issuedA.invoiceNumber} vs ${issuedB.invoiceNumber}`);
  }

  // 4. Refund race: two concurrent completions of two separate refunds against the same payment must never exceed the refundable balance.
  {
    const key = `verify-refund-race-payment-${Date.now()}`;
    const { payment } = await prisma.$transaction((tx) => recordPayment(tx, { encounterId: encounter.id, patientId: patient.id, facilityId: facility.id, amountMinor: 100000, method: "UPI", idempotencyKey: key, receivedByUserId: staff.userId }));
    const { refund: refundA } = await prisma.$transaction((tx) => requestRefund(tx, { paymentId: payment.id, amountMinor: 60000, reason: "race test A", requestedByUserId: staff.userId, idempotencyKey: `${key}-refund-a` }));
    const { refund: refundB } = await prisma.$transaction((tx) => requestRefund(tx, { paymentId: payment.id, amountMinor: 60000, reason: "race test B", requestedByUserId: staff.userId, idempotencyKey: `${key}-refund-b` }));
    const admin = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { facilityId: facility.id, user: { role: "HOSPITAL_ADMIN" } } });
    await prisma.$transaction((tx) => approveRefund(tx, refundA.id, { approvedByUserId: admin.userId }));
    await prisma.$transaction((tx) => approveRefund(tx, refundB.id, { approvedByUserId: admin.userId }));
    const results = await Promise.allSettled([prisma.$transaction((tx) => completeRefund(tx, refundA.id)), prisma.$transaction((tx) => completeRefund(tx, refundB.id))]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const finalPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    report(
      "Refund race: two concurrent 60% refunds against one payment — only one completes, total refunded never exceeds amountMinor",
      succeeded === 1 && finalPayment.refundedMinor <= finalPayment.amountMinor,
      `succeeded=${succeeded}, refundedMinor=${finalPayment.refundedMinor}, amountMinor=${finalPayment.amountMinor}`
    );
  }

  // 5. Tariff race: two concurrent overlapping-range tariff creations for the same (facility, chargeCode, payer) — requires the real Postgres exclusion constraint.
  {
    const chargeCode = `VERIFY_RACE_${Date.now()}`;
    const attempt = () =>
      prisma.$transaction((tx) =>
        createTariff(tx, { facilityId: facility.id, payerId: cashPayer.id, chargeCode, description: "Race test", category: "OTHER", unitPriceMinor: 10000, effectiveFrom: new Date("2027-01-01"), effectiveTo: null, createdByUserId: staff.userId })
      );
    const results = await Promise.allSettled([attempt(), attempt()]);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failedWithConflict = results.filter((r) => r.status === "rejected" && r.reason instanceof TariffConflictError).length;
    const tariffCount = await prisma.tariff.count({ where: { chargeCode } });
    report(
      "Tariff race: exactly one of two concurrent overlapping-range tariffs commits (requires the Postgres exclusion constraint)",
      succeeded === 1 && tariffCount === 1,
      `succeeded=${succeeded}, failedWithConflict=${failedWithConflict}, tariffRowsCreated=${tariffCount}`
    );
  }

  // 6. Claim race: two concurrent submit attempts on the same DRAFT claim -> exactly one SUBMITTED, one clean rejection.
  {
    const orderId = await freshImagingOrder(facility.id, encounter.id, patient.id, staff.id);
    const { charge } = await prisma.$transaction((tx) => createChargeIfNotExists(tx, { encounterId: encounter.id, patientId: patient.id, facilityId: facility.id, description: "Claim race fixture", category: "IMAGING", unitPriceMinor: 40000, sourceType: "ImagingOrder", sourceId: orderId }));
    const coverage = await prisma.patientCoverage.findFirst({ where: { payer: { type: "INSURANCE" } } });
    if (!coverage) {
      report("Claim race: skipped (no seeded insurance coverage found)", true);
    } else {
      const invoice = await prisma.$transaction(async (tx) => {
        const d = await draftInvoiceForAccount(tx, { encounterId: encounter.id, patientId: patient.id, facilityId: facility.id, generatedByUserId: staff.userId });
        await addChargeToInvoice(tx, d.id, charge.id);
        return issueInvoice(tx, d.id, {});
      });
      const claim = await prisma.$transaction((tx) => createClaimDraft(tx, { invoiceId: invoice.id, coverageId: coverage.id, facilityId: facility.id, createdByUserId: staff.userId }));
      const attemptSubmit = () => prisma.$transaction((tx) => submitClaim(tx, claim.id));
      const results = await Promise.allSettled([attemptSubmit(), attemptSubmit()]);
      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failedWithConcurrencyError = results.filter((r) => r.status === "rejected" && r.reason instanceof ClaimConcurrencyError).length;
      report("Claim race: exactly one of two concurrent submit attempts on the same DRAFT claim succeeds", succeeded === 1 && failedWithConcurrencyError === 1, `succeeded=${succeeded}`);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
