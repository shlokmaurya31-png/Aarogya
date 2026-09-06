import { Prisma, PaymentMethod } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { getOrCreateBillingAccount } from "./billingAccount";
import { refreshInvoicePaymentStatus } from "./invoices";

type Tx = Prisma.TransactionClient;

export class PaymentConcurrencyError extends BadRequestError {
  constructor() {
    super("Too much concurrent activity on this payment — please retry.");
  }
}

export class OverAllocationError extends BadRequestError {
  constructor() {
    super("This allocation would exceed either the payment's available balance or the invoice's outstanding balance.");
  }
}

export class PaymentHasActivityError extends BadRequestError {
  constructor() {
    super("This payment has allocations or refunds and cannot be voided directly.");
  }
}

interface RecordPaymentInput {
  encounterId: string;
  patientId: string;
  facilityId: string;
  amountMinor: number;
  method: PaymentMethod;
  idempotencyKey: string;
  referenceNo?: string;
  receivedByUserId: string;
}

/**
 * Records a received payment. A deposit/advance is simply a Payment with
 * zero allocations — "money received with no invoice to apply it to yet"
 * already IS an unallocated payment, so there is no separate Deposit model
 * (see deposits.ts, a thin discoverability wrapper over this function).
 * Idempotent on idempotencyKey — the payment-race anchor: the same
 * client/gateway-generated key on retry must never produce two postings.
 */
export async function recordPayment(tx: Tx, input: RecordPaymentInput) {
  const existing = await tx.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return { payment: existing, alreadyExisted: true as const };

  if (input.amountMinor <= 0) throw new BadRequestError("amountMinor must be positive.");

  const account = await getOrCreateBillingAccount(tx, { encounterId: input.encounterId, patientId: input.patientId, facilityId: input.facilityId });

  // Raw INSERT ... ON CONFLICT DO NOTHING — see chargeCapture.ts's
  // createChargeIfNotExists for the full explanation (create-then-catch-
  // P2002 aborts the whole Postgres transaction; createMany+skipDuplicates
  // isn't supported by Prisma's SQLite connector at all). Standard SQL,
  // identical on SQLite 3.24+ and Postgres, never throws on conflict.
  //
  // `method` is injected as a raw (non-parameterized) literal, not a
  // `${}` bind parameter: on Postgres, `method` is a native enum column,
  // and Postgres will NOT implicitly cast a bound text parameter to a
  // custom enum type in an INSERT (only unqualified string literals get
  // that implicit cast) — verified empirically (42804 "column is of type
  // PaymentMethod but expression is of type text"). Safe to inline
  // directly because `input.method: PaymentMethod` is a closed TypeScript
  // enum, not free-text user input; the runtime check below is defense in
  // depth against a future refactor loosening that type.
  if (!Object.values(PaymentMethod).includes(input.method)) throw new BadRequestError("Invalid payment method.");
  const rowsInserted = await tx.$executeRaw`
    INSERT INTO "Payment" (id, "billingAccountId", "patientId", "facilityId", "amountMinor", method, "idempotencyKey", "referenceNo", "receivedByUserId")
    VALUES (${randomUUID()}, ${account.id}, ${input.patientId}, ${input.facilityId}, ${input.amountMinor}, ${Prisma.raw(`'${input.method}'`)}, ${input.idempotencyKey}, ${input.referenceNo ?? null}, ${input.receivedByUserId})
    ON CONFLICT ("idempotencyKey") DO NOTHING
  `;
  const payment = await tx.payment.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });

  return { payment, alreadyExisted: rowsInserted === 0 };
}

/**
 * Applies (part of) a payment's unallocated balance to an invoice.
 * allocatedMinor is a guarded running cache (CAS-updated here, in the same
 * transaction as the PaymentAllocation row it summarizes) — not a blind
 * increment. A losing concurrent allocation retries against the freshly
 * observed value up to a bounded number of times, then surfaces a clean
 * error rather than corrupting the cap invariant
 * (allocatedMinor + refundedMinor <= amountMinor).
 */
export async function allocatePayment(
  tx: Tx,
  input: { paymentId: string; invoiceId: string; amountMinor: number; allocatedByUserId: string }
) {
  if (input.amountMinor <= 0) throw new BadRequestError("amountMinor must be positive.");

  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: input.invoiceId }, include: { allocations: true } });
  if (invoice.status !== "ISSUED" && invoice.status !== "PARTIALLY_PAID") {
    throw new BadRequestError(`Cannot allocate a payment to an invoice in status ${invoice.status}.`);
  }
  const alreadyAllocatedToInvoice = invoice.allocations.reduce((sum, a) => sum + a.amountMinor, 0);
  const invoiceRemaining = invoice.totalMinor - alreadyAllocatedToInvoice;
  if (input.amountMinor > invoiceRemaining) throw new OverAllocationError();

  for (let attempt = 0; attempt < 5; attempt++) {
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: input.paymentId } });
    if (payment.status !== "RECEIVED") throw new BadRequestError("Payment is not in a state that can be allocated.");
    const available = payment.amountMinor - payment.allocatedMinor - payment.refundedMinor;
    if (input.amountMinor > available) throw new OverAllocationError();

    const result = await tx.payment.updateMany({
      where: { id: input.paymentId, allocatedMinor: payment.allocatedMinor },
      data: { allocatedMinor: payment.allocatedMinor + input.amountMinor },
    });
    if (result.count === 1) {
      await tx.paymentAllocation.create({
        data: { paymentId: input.paymentId, invoiceId: input.invoiceId, amountMinor: input.amountMinor, allocatedByUserId: input.allocatedByUserId },
      });
      await refreshInvoicePaymentStatus(tx, input.invoiceId);
      return tx.payment.findUniqueOrThrow({ where: { id: input.paymentId } });
    }
  }
  throw new PaymentConcurrencyError();
}

/** Only legal while nothing has happened to the payment yet — any allocation or refund means voiding requires unwinding those first (not built this phase; use a FinancialAdjustment on the affected invoice instead). */
export async function voidPayment(tx: Tx, paymentId: string, input: { reason: string; byUserId: string }) {
  const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
  if (payment.allocatedMinor > 0 || payment.refundedMinor > 0) throw new PaymentHasActivityError();

  const result = await tx.payment.updateMany({
    where: { id: paymentId, status: "RECEIVED" },
    data: { status: "VOIDED", voidedAt: new Date(), voidedByUserId: input.byUserId, voidReason: input.reason },
  });
  if (result.count !== 1) throw new BadRequestError("Payment was already voided or is no longer in the expected state.");
  return tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
}

export async function findPaymentInFacility(paymentId: string, facilityId: string) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, include: { allocations: true, refunds: true } });
  if (!payment || payment.facilityId !== facilityId) throw new NotFoundError("Payment not found.");
  return payment;
}
