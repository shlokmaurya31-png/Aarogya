import { Prisma, type BillingProviderKind } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { type ActorMemberships } from "@/lib/auth/tenantContext";
import { requirePlatform } from "./authz";

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
  if (v !== "NONE" && v !== "FAKE") throw new BadRequestError("Invalid provider kind.");
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
  }
  return { refund, alreadyExisted: Number(rowsInserted) === 0 };
}

/** Platform-only route entry. */
export async function refundPayment(m: ActorMemberships, input: Omit<RefundInput, "createdByUserId">) {
  requirePlatform(m);
  return prisma.$transaction(
    (tx) => refundPaymentTx(tx, { ...input, createdByUserId: m.userId }),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 }
  );
}
