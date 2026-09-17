import { Prisma, type BillingProviderKind, type BillingPaymentAttemptStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { type ActorMemberships } from "@/lib/auth/tenantContext";
import { requirePlatform } from "./authz";
import { isInvoicePayable } from "./constants";
import { refreshInvoicePaymentStatus } from "./invoices";

type Tx = Prisma.TransactionClient;

/**
 * Phase D3 — SaaS payment recording.
 *
 * A payment ATTEMPT (which may fail) is distinct from a recorded PAYMENT (money
 * that actually succeeded). Both are idempotent on a caller-supplied
 * idempotencyKey via a raw INSERT ... ON CONFLICT DO NOTHING — so N identical
 * concurrent requests create exactly one row and apply money exactly once. The
 * invoice's amountPaidMinor is a guarded running total: an atomic conditional
 * UPDATE (amountPaidMinor + amt <= totalMinor) makes over-payment impossible even
 * under concurrency. The UI never mutates payment state; only these services do.
 */

function rawEnum(v: BillingProviderKind): Prisma.Sql {
  if (v !== "NONE" && v !== "FAKE" && v !== "RAZORPAY") throw new BadRequestError("Invalid provider kind.");
  return Prisma.raw(`'${v}'`);
}

export interface CreateAttemptInput {
  invoiceId: string;
  amountMinor: number;
  idempotencyKey: string;
  providerKind?: BillingProviderKind;
  createdByUserId: string | null;
}

/**
 * Create (or return the existing) payment attempt for an invoice. Idempotent on
 * idempotencyKey. Validates the invoice is payable and the amount does not exceed
 * the outstanding balance.
 */
export async function createPaymentAttempt(tx: Tx, input: CreateAttemptInput) {
  const providerKind = input.providerKind ?? "NONE";
  const invoice = await tx.billingInvoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice) throw new NotFoundError();
  if (!isInvoicePayable(invoice.status)) throw new BadRequestError(`Invoice ${invoice.status} is not payable.`);
  if (input.amountMinor <= 0) throw new BadRequestError("amountMinor must be positive.");
  const due = invoice.totalMinor - invoice.amountPaidMinor;
  if (input.amountMinor > due) throw new BadRequestError("Attempt amount exceeds the invoice's outstanding balance.");

  await tx.$executeRaw`
    INSERT INTO "BillingPaymentAttempt" (id, "invoiceId", "organizationId", "amountMinor", currency, "idempotencyKey", "providerKind", "createdByUserId")
    VALUES (${randomUUID()}, ${input.invoiceId}, ${invoice.organizationId}, ${input.amountMinor}, ${invoice.currency}, ${input.idempotencyKey}, ${rawEnum(providerKind)}, ${input.createdByUserId})
    ON CONFLICT ("idempotencyKey") DO NOTHING
  `;
  return tx.billingPaymentAttempt.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
}

/** Transition an attempt (INITIATED/PENDING -> SUCCEEDED/FAILED/CANCELLED), guarded. */
export async function markAttempt(tx: Tx, attemptId: string, to: BillingPaymentAttemptStatus, extra?: { providerPaymentRef?: string | null; failureReason?: string | null }) {
  const result = await tx.billingPaymentAttempt.updateMany({
    where: { id: attemptId, status: { in: ["INITIATED", "PENDING"] } },
    data: { status: to, providerPaymentRef: extra?.providerPaymentRef ?? undefined, failureReason: extra?.failureReason ?? undefined },
  });
  if (result.count !== 1) throw new ConflictError("Payment attempt was already finalized.");
  return tx.billingPaymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
}

export interface RecordPaymentInput {
  invoiceId: string;
  attemptId?: string | null;
  amountMinor: number;
  idempotencyKey: string;
  providerKind?: BillingProviderKind;
  providerPaymentRef?: string | null;
  method?: string | null;
  createdByUserId: string | null;
}

/**
 * Record a SUCCEEDED payment and apply it to the invoice's guarded amountPaid
 * total, all in the caller's transaction. Idempotent: if the payment row already
 * exists (same idempotencyKey) the money is NOT applied a second time.
 */
export async function recordPayment(tx: Tx, input: RecordPaymentInput) {
  const providerKind = input.providerKind ?? "NONE";
  const invoice = await tx.billingInvoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice) throw new NotFoundError();
  if (input.amountMinor <= 0) throw new BadRequestError("amountMinor must be positive.");

  const rowsInserted = await tx.$executeRaw`
    INSERT INTO "BillingPayment" (id, "invoiceId", "organizationId", "attemptId", "amountMinor", currency, method, "providerKind", "providerPaymentRef", "idempotencyKey", "createdByUserId")
    VALUES (${randomUUID()}, ${input.invoiceId}, ${invoice.organizationId}, ${input.attemptId ?? null}, ${input.amountMinor}, ${invoice.currency}, ${input.method ?? null}, ${rawEnum(providerKind)}, ${input.providerPaymentRef ?? null}, ${input.idempotencyKey}, ${input.createdByUserId})
    ON CONFLICT ("idempotencyKey") DO NOTHING
  `;
  const payment = await tx.billingPayment.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });

  // Apply money exactly once — only when THIS call created the payment row.
  if (Number(rowsInserted) === 1) {
    const applied = await tx.$executeRaw`
      UPDATE "BillingInvoice" SET "amountPaidMinor" = "amountPaidMinor" + ${input.amountMinor}
      WHERE id = ${input.invoiceId} AND "amountPaidMinor" + ${input.amountMinor} <= "totalMinor"
    `;
    if (Number(applied) !== 1) throw new BadRequestError("This payment would exceed the invoice total.");
    await refreshInvoicePaymentStatus(tx, input.invoiceId);
    await recordAuditEvent("commercial.billing.paymentRecorded", input.createdByUserId, { invoiceId: input.invoiceId, paymentId: payment.id, amountMinor: input.amountMinor }, { organizationId: invoice.organizationId }, tx);
  }
  return { payment, alreadyExisted: Number(rowsInserted) === 0 };
}

/**
 * Platform-only: record a payment received out-of-band (no live gateway call).
 * Wraps attempt + payment in one Serializable transaction so it is race-safe.
 */
export async function recordManualPayment(m: ActorMemberships, input: { invoiceId: string; amountMinor: number; method?: string; idempotencyKey: string }) {
  requirePlatform(m);
  return prisma.$transaction(async (tx) => {
    const attempt = await createPaymentAttempt(tx, {
      invoiceId: input.invoiceId, amountMinor: input.amountMinor, idempotencyKey: `att:${input.idempotencyKey}`,
      providerKind: "NONE", createdByUserId: m.userId,
    });
    if (attempt.status === "INITIATED") await markAttempt(tx, attempt.id, "SUCCEEDED");
    const { payment } = await recordPayment(tx, {
      invoiceId: input.invoiceId, attemptId: attempt.id, amountMinor: input.amountMinor,
      idempotencyKey: `pay:${input.idempotencyKey}`, providerKind: "NONE", method: input.method ?? "MANUAL",
      createdByUserId: m.userId,
    });
    return payment;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });
}
