import { Prisma, type BillingProviderKind } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { type ActorMemberships } from "@/lib/auth/tenantContext";
import { requirePlatform } from "./authz";
import { getProvider } from "./provider";

type Tx = Prisma.TransactionClient;

/**
 * Phase D3 — refunds against a SaaS payment.
 *
 * Platform-only. A refund references the original payment and never mutates it in
 * place; the payment's refundedMinor is a guarded running total, so a refund can
 * never exceed the un-refunded balance even under concurrency (atomic conditional
 * UPDATE: refundedMinor + amt <= amountMinor). Idempotent on idempotencyKey.
 */

function rawEnum(v: BillingProviderKind): Prisma.Sql {
  if (v !== "NONE" && v !== "FAKE" && v !== "RAZORPAY") throw new BadRequestError("Invalid provider kind.");
  return Prisma.raw(`'${v}'`);
}

export interface RefundInput {
  paymentId: string;
  amountMinor: number;
  reason: string;
  idempotencyKey: string;
  providerKind?: BillingProviderKind;
  providerRefundRef?: string | null;
  createdByUserId: string | null;
}

/** Core refund, race-safe. Runs in the caller's transaction. */
export async function refundPaymentTx(tx: Tx, input: RefundInput) {
  const providerKind = input.providerKind ?? "NONE";
  const payment = await tx.billingPayment.findUnique({ where: { id: input.paymentId } });
  if (!payment) throw new NotFoundError();
  if (input.amountMinor <= 0) throw new BadRequestError("Refund amount must be positive.");

  const rowsInserted = await tx.$executeRaw`
    INSERT INTO "BillingRefund" (id, "paymentId", "organizationId", "amountMinor", reason, "idempotencyKey", "providerKind", "providerRefundRef", "createdByUserId")
    VALUES (${randomUUID()}, ${input.paymentId}, ${payment.organizationId}, ${input.amountMinor}, ${input.reason}, ${input.idempotencyKey}, ${rawEnum(providerKind)}, ${input.providerRefundRef ?? null}, ${input.createdByUserId})
    ON CONFLICT ("idempotencyKey") DO NOTHING
  `;
  const refund = await tx.billingRefund.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });

  // Apply to the payment's guarded refundedMinor exactly once.
  if (Number(rowsInserted) === 1) {
    const applied = await tx.$executeRaw`
      UPDATE "BillingPayment" SET "refundedMinor" = "refundedMinor" + ${input.amountMinor}
      WHERE id = ${input.paymentId} AND "refundedMinor" + ${input.amountMinor} <= "amountMinor"
    `;
    if (Number(applied) !== 1) throw new BadRequestError("Refund would exceed the payment's un-refunded balance.");
    const after = await tx.billingPayment.findUniqueOrThrow({ where: { id: input.paymentId } });
    const status = after.refundedMinor >= after.amountMinor ? "REFUNDED" : after.refundedMinor > 0 ? "PARTIALLY_REFUNDED" : after.status;
    if (status !== after.status) await tx.billingPayment.update({ where: { id: input.paymentId }, data: { status } });
    await recordAuditEvent("commercial.billing.refundCreated", input.createdByUserId, { paymentId: input.paymentId, refundId: refund.id, amountMinor: input.amountMinor }, { organizationId: payment.organizationId }, tx);
    await emitDomainEvent(tx, {
      type: "RefundIssued",
      aggregateId: refund.id,
      organizationId: payment.organizationId,
      actorUserId: input.createdByUserId,
      payload: { refundId: refund.id, paymentId: input.paymentId, amountMinor: input.amountMinor, currency: payment.currency },
    });
  }
  return { refund, alreadyExisted: Number(rowsInserted) === 0 };
}

/** Platform-only route entry (domain-only; used for manual/out-of-band refunds). */
export async function refundPayment(m: ActorMemberships, input: Omit<RefundInput, "createdByUserId">) {
  requirePlatform(m);
  return prisma.$transaction(
    (tx) => refundPaymentTx(tx, { ...input, createdByUserId: m.userId }),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 }
  );
}

/**
 * Platform-only: refund through the real provider (Phase D4).
 *
 * Distributed-failure discipline:
 *  - If a refund with this idempotencyKey already exists, the provider is NOT
 *    called again (no double refund).
 *  - The ceiling is validated against the payment BEFORE calling the provider, so
 *    we never issue a provider refund we cannot legally record.
 *  - If the provider call throws (ambiguous outcome), or the local record fails
 *    after a provider success, a REFUND_MISMATCH reconciliation exception is
 *    raised rather than pretending the operation was exactly-once.
 */
export async function refundViaProvider(m: ActorMemberships, input: { paymentId: string; amountMinor: number; reason: string; idempotencyKey: string; providerKind: "FAKE" | "RAZORPAY" }) {
  requirePlatform(m);
  const existing = await prisma.billingRefund.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return existing; // idempotent — never re-call the provider

  const payment = await prisma.billingPayment.findUnique({ where: { id: input.paymentId } });
  if (!payment) throw new NotFoundError();
  if (input.amountMinor <= 0) throw new BadRequestError("Refund amount must be positive.");
  if (input.amountMinor > payment.amountMinor - payment.refundedMinor) throw new BadRequestError("Refund would exceed the payment's un-refunded balance.");
  if (!payment.providerPaymentRef) throw new BadRequestError("Payment has no provider reference to refund against.");

  let providerRefundRef: string | null = null;
  try {
    const res = await getProvider(input.providerKind).refundPayment({ providerPaymentRef: payment.providerPaymentRef, amountMinor: input.amountMinor, idempotencyKey: input.idempotencyKey });
    if (res.status === "failed") throw new BadRequestError("Provider refused the refund.");
    providerRefundRef = res.providerRefundRef;
  } catch (err) {
    await prisma.billingReconciliationException.create({
      data: { kind: "REFUND_MISMATCH", organizationId: payment.organizationId, providerKind: input.providerKind, severity: "HIGH", entityType: "payment", entityId: payment.id, providerRef: payment.providerPaymentRef, description: "Provider refund outcome ambiguous or refused." },
    });
    throw err;
  }

  try {
    const { refund } = await prisma.$transaction(
      (tx) => refundPaymentTx(tx, { ...input, providerRefundRef, createdByUserId: m.userId }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 }
    );
    return refund;
  } catch (err) {
    await prisma.billingReconciliationException.create({
      data: { kind: "REFUND_MISMATCH", organizationId: payment.organizationId, providerKind: input.providerKind, severity: "CRITICAL", entityType: "payment", entityId: payment.id, providerRef: providerRefundRef, description: "Provider refund succeeded but local record failed; reconcile." },
    });
    throw err;
  }
}
