import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { sumMinor } from "./money";

type Tx = Prisma.TransactionClient;

/**
 * Lazily creates the one BillingAccount an encounter ever has — same call
 * shape as the old Bill upsert it replaces. Raw INSERT ... ON CONFLICT DO
 * NOTHING, not upsert with an empty update or createMany+skipDuplicates —
 * see chargeCapture.ts's createChargeIfNotExists for the full explanation.
 * Every charge/payment call funnels through here for the same
 * encounterId, so this is a real, not theoretical, hot path for the race.
 */
export async function getOrCreateBillingAccount(
  tx: Tx,
  input: { encounterId: string; patientId: string; facilityId: string }
) {
  await tx.$executeRaw`
    INSERT INTO "BillingAccount" (id, "encounterId", "patientId", "facilityId")
    VALUES (${randomUUID()}, ${input.encounterId}, ${input.patientId}, ${input.facilityId})
    ON CONFLICT ("encounterId") DO NOTHING
  `;
  return tx.billingAccount.findUniqueOrThrow({ where: { encounterId: input.encounterId } });
}

export interface AccountSummary {
  currency: string;
  grossChargesMinor: number; // Σ Charge.netAmountMinor, status=POSTED
  invoicedMinor: number; // Σ Invoice.totalMinor, status != VOID
  paidMinor: number; // Σ PaymentAllocation.amountMinor against this account's invoices
  unappliedCreditMinor: number; // deposits/advances not yet allocated to any invoice
  creditAdjustmentsMinor: number; // Σ approved CREDIT_NOTE + WRITE_OFF
  debitAdjustmentsMinor: number; // Σ approved DEBIT_NOTE
  refundedMinor: number; // Σ Payment.refundedMinor
  outstandingMinor: number; // invoicedMinor - paidMinor - creditAdjustmentsMinor + debitAdjustmentsMinor
}

/**
 * Every number here is derived live from immutable/append-only rows — no
 * stored counter, matching dischargeBarrierEngine.ts's "don't store what
 * can go stale" philosophy and deliberately replacing the old Bill
 * model's mutable totalAmount/paidAmount, which drifted from reality with
 * no reconciliation. Not cheap (several aggregate queries), but this is a
 * per-account read on a billing detail page, not a hot path.
 */
export async function computeAccountSummary(encounterId: string): Promise<AccountSummary> {
  const account = await prisma.billingAccount.findUnique({ where: { encounterId } });
  if (!account) {
    return {
      currency: "INR",
      grossChargesMinor: 0,
      invoicedMinor: 0,
      paidMinor: 0,
      unappliedCreditMinor: 0,
      creditAdjustmentsMinor: 0,
      debitAdjustmentsMinor: 0,
      refundedMinor: 0,
      outstandingMinor: 0,
    };
  }

  const [charges, invoices, payments, adjustments] = await Promise.all([
    prisma.charge.findMany({ where: { encounterId, status: "POSTED" }, select: { netAmountMinor: true } }),
    prisma.invoice.findMany({
      where: { billingAccountId: account.id, status: { not: "VOID" } },
      select: { id: true, totalMinor: true, allocations: { select: { amountMinor: true } } },
    }),
    prisma.payment.findMany({
      where: { billingAccountId: account.id, status: "RECEIVED" },
      select: { amountMinor: true, allocatedMinor: true, refundedMinor: true },
    }),
    prisma.financialAdjustment.findMany({
      where: { status: "APPROVED", invoice: { billingAccountId: account.id } },
      select: { type: true, amountMinor: true },
    }),
  ]);

  const grossChargesMinor = sumMinor(charges.map((c) => c.netAmountMinor));
  const invoicedMinor = sumMinor(invoices.map((i) => i.totalMinor));
  const paidMinor = sumMinor(invoices.flatMap((i) => i.allocations.map((a) => a.amountMinor)));
  const unappliedCreditMinor = sumMinor(payments.map((p) => p.amountMinor - p.allocatedMinor - p.refundedMinor));
  const refundedMinor = sumMinor(payments.map((p) => p.refundedMinor));
  const creditAdjustmentsMinor = sumMinor(
    adjustments.filter((a) => a.type === "CREDIT_NOTE" || a.type === "WRITE_OFF").map((a) => a.amountMinor)
  );
  const debitAdjustmentsMinor = sumMinor(adjustments.filter((a) => a.type === "DEBIT_NOTE").map((a) => a.amountMinor));

  return {
    currency: "INR",
    grossChargesMinor,
    invoicedMinor,
    paidMinor,
    unappliedCreditMinor,
    creditAdjustmentsMinor,
    debitAdjustmentsMinor,
    refundedMinor,
    outstandingMinor: invoicedMinor - paidMinor - creditAdjustmentsMinor + debitAdjustmentsMinor,
  };
}
