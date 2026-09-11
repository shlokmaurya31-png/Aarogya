import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { SETTLEMENT_TRANSITIONS, EXCEPTION_TRANSITIONS, isTransitionAllowed } from "./stateMachines";

/**
 * Phase C5 — settlement and reconciliation.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * RECONCILIATION NEVER MOVES MONEY.
 *
 * It compares two INDEPENDENT records — the external settlement notification
 * and the canonical Payment ledger — and raises findings where they disagree.
 * It does not create payments, adjust invoices, or correct balances.
 *
 * That separation is the whole point: if an external message could write into
 * the ledger, there would be nothing left to reconcile against, and a forged
 * settlement would become money. Every correction is a deliberate human act
 * through the existing Phase 5 billing services.
 * ════════════════════════════════════════════════════════════════════════════
 */

export interface RecordSettlementInput {
  facilityId: string;
  claimId: string;
  externalSettlementRef: string;
  settledAmountMinor: number;
  settlementDate?: Date | null;
  byUserId: string;
  notes?: string;
}

/**
 * Record an external settlement notification.
 *
 * The unique (facility, reference) constraint is what stops the same settlement
 * being counted twice — enforced by the database, not by a check-then-insert,
 * because duplicate settlements arrive concurrently in practice.
 */
export async function recordSettlement(input: RecordSettlementInput) {
  if (!Number.isInteger(input.settledAmountMinor) || input.settledAmountMinor < 0) {
    // Money is integer minor units everywhere. A float here would silently
    // introduce rounding error into a financial record.
    throw new BadRequestError("settledAmountMinor must be a non-negative integer (minor units).");
  }
  if (!input.externalSettlementRef?.trim()) {
    throw new BadRequestError("An external settlement reference is required.");
  }

  const claim = await prisma.claim.findUnique({ where: { id: input.claimId } });
  if (!claim || claim.facilityId !== input.facilityId) throw new NotFoundError("Claim not found.");

  try {
    const settlement = await prisma.claimSettlement.create({
      data: {
        facilityId: input.facilityId,
        claimId: input.claimId,
        externalSettlementRef: input.externalSettlementRef.trim(),
        settledAmountMinor: input.settledAmountMinor,
        settlementDate: input.settlementDate ?? null,
        status: "NOTIFIED",
        notes: input.notes,
      },
    });

    await recordAuditEvent(
      "hospital.claim.settlementRecorded",
      input.byUserId,
      {
        claimId: input.claimId, settlementId: settlement.id,
        externalSettlementRef: settlement.externalSettlementRef,
        settledAmountMinor: input.settledAmountMinor,
      },
      { facilityId: input.facilityId }
    );
    return { settlement, duplicate: false };
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") {
      const existing = await prisma.claimSettlement.findUnique({
        where: {
          facilityId_externalSettlementRef: {
            facilityId: input.facilityId,
            externalSettlementRef: input.externalSettlementRef.trim(),
          },
        },
      });
      // A repeat notification is NOT an error, but if the amount differs it is
      // a genuine discrepancy that a human must look at.
      if (existing && existing.settledAmountMinor !== input.settledAmountMinor) {
        await raiseException({
          facilityId: input.facilityId,
          claimId: input.claimId,
          settlementId: existing.id,
          exceptionType: "DUPLICATE_SETTLEMENT",
          severity: "CRITICAL",
          expectedAmountMinor: existing.settledAmountMinor,
          actualAmountMinor: input.settledAmountMinor,
          detail: `Settlement ${input.externalSettlementRef} was notified again with a different amount.`,
          byUserId: input.byUserId,
        });
      }
      return { settlement: existing!, duplicate: true };
    }
    throw e;
  }
}

/**
 * Reconcile a settlement against canonical payments.
 *
 * Records the match and raises findings. It creates NO Payment and alters NO
 * invoice — linking a settlement to a payment is an assertion that they
 * correspond, not an instruction to move money.
 */
export async function reconcileSettlement(input: {
  facilityId: string;
  settlementId: string;
  paymentId?: string | null;
  byUserId: string;
  note?: string;
}) {
  return prisma.$transaction(async (tx) => {
    const settlement = await tx.claimSettlement.findUnique({ where: { id: input.settlementId } });
    if (!settlement || settlement.facilityId !== input.facilityId) throw new NotFoundError("Settlement not found.");
    if (!isTransitionAllowed(SETTLEMENT_TRANSITIONS, settlement.status, "RECONCILED")) {
      throw new BadRequestError(`A ${settlement.status} settlement cannot be reconciled.`);
    }

    if (input.paymentId) {
      const payment = await tx.payment.findUnique({ where: { id: input.paymentId } });
      // Cross-facility payment linkage would let one facility's settlement
      // claim another's money.
      if (!payment || payment.facilityId !== input.facilityId) throw new NotFoundError("Payment not found.");
    }

    const r = await tx.claimSettlement.updateMany({
      where: { id: settlement.id, status: settlement.status, version: settlement.version },
      data: {
        status: "RECONCILED",
        paymentId: input.paymentId ?? null,
        reconciledAt: new Date(),
        reconciledByUserId: input.byUserId,
        notes: input.note ?? settlement.notes,
        version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new ConflictError("That settlement changed concurrently.");

    await tx.auditEvent.create({
      data: {
        type: "hospital.claim.settlementReconciled",
        userId: input.byUserId,
        detail: {
          settlementId: settlement.id, claimId: settlement.claimId,
          paymentId: input.paymentId ?? null, settledAmountMinor: settlement.settledAmountMinor,
        },
        facilityId: settlement.facilityId,
      },
    });
    return tx.claimSettlement.findUniqueOrThrow({ where: { id: settlement.id } });
  });
}

export async function raiseException(input: {
  facilityId: string;
  exceptionType: string;
  detail: string;
  byUserId: string;
  claimId?: string | null;
  invoiceId?: string | null;
  paymentId?: string | null;
  settlementId?: string | null;
  severity?: string;
  expectedAmountMinor?: number | null;
  actualAmountMinor?: number | null;
}) {
  const variance =
    input.expectedAmountMinor !== null && input.expectedAmountMinor !== undefined &&
    input.actualAmountMinor !== null && input.actualAmountMinor !== undefined
      ? input.actualAmountMinor - input.expectedAmountMinor
      : null;

  const exception = await prisma.reconciliationException.create({
    data: {
      facilityId: input.facilityId,
      claimId: input.claimId ?? null,
      invoiceId: input.invoiceId ?? null,
      paymentId: input.paymentId ?? null,
      settlementId: input.settlementId ?? null,
      exceptionType: input.exceptionType,
      severity: input.severity ?? "WARNING",
      expectedAmountMinor: input.expectedAmountMinor ?? null,
      actualAmountMinor: input.actualAmountMinor ?? null,
      varianceMinor: variance,
      detail: input.detail,
      status: "OPEN",
    },
  });
  await recordAuditEvent(
    "hospital.claim.reconciliationException",
    input.byUserId,
    { exceptionId: exception.id, exceptionType: input.exceptionType, severity: exception.severity, varianceMinor: variance },
    { facilityId: input.facilityId }
  );
  return exception;
}

/**
 * Scan a claim for reconciliation discrepancies.
 *
 * Read-only apart from raising findings. All arithmetic is integer minor units.
 */
export async function reconcileClaim(input: { facilityId: string; claimId: string; byUserId: string }) {
  const claim = await prisma.claim.findUnique({
    where: { id: input.claimId },
    include: { invoice: true },
  });
  if (!claim || claim.facilityId !== input.facilityId) throw new NotFoundError("Claim not found.");

  const settlements = await prisma.claimSettlement.findMany({
    where: { facilityId: input.facilityId, claimId: claim.id },
  });
  const settledTotal = settlements
    .filter((s) => s.status !== "REJECTED")
    .reduce((sum, s) => sum + s.settledAmountMinor, 0);

  const findings: { type: string; detail: string; severity: string }[] = [];

  if (claim.approvedAmountMinor !== null) {
    if (settlements.length === 0 && ["APPROVED", "PARTIALLY_APPROVED"].includes(claim.status)) {
      findings.push({
        type: "MISSING_SETTLEMENT", severity: "WARNING",
        detail: `Claim is ${claim.status} for ${claim.approvedAmountMinor} minor units but no settlement has been notified.`,
      });
    }
    if (settledTotal > claim.approvedAmountMinor) {
      findings.push({
        type: "OVERPAYMENT", severity: "CRITICAL",
        detail: `Settled ${settledTotal} exceeds approved ${claim.approvedAmountMinor}.`,
      });
    }
    if (settledTotal > 0 && settledTotal < claim.approvedAmountMinor) {
      findings.push({
        type: "UNDERPAYMENT", severity: "WARNING",
        detail: `Settled ${settledTotal} is less than approved ${claim.approvedAmountMinor}.`,
      });
    }
  }

  if (claim.approvedAmountMinor !== null && claim.approvedAmountMinor > claim.submittedAmountMinor) {
    // Approved above claimed is never legitimate and usually indicates a
    // corrupted or forged adjudication.
    findings.push({
      type: "AMOUNT_MISMATCH", severity: "CRITICAL",
      detail: `Approved ${claim.approvedAmountMinor} exceeds the claimed ${claim.submittedAmountMinor}.`,
    });
  }

  const orphans = settlements.filter((s) => s.status === "RECONCILED" && !s.paymentId);
  for (const o of orphans) {
    findings.push({
      type: "ORPHAN_EXTERNAL_REFERENCE", severity: "WARNING",
      detail: `Settlement ${o.externalSettlementRef} is reconciled but linked to no canonical payment.`,
    });
  }

  const created = [];
  for (const f of findings) {
    // Do not re-raise a finding that is already open for this claim.
    const existing = await prisma.reconciliationException.findFirst({
      where: { facilityId: input.facilityId, claimId: claim.id, exceptionType: f.type, status: "OPEN" },
    });
    if (existing) continue;
    created.push(await raiseException({
      facilityId: input.facilityId, claimId: claim.id, invoiceId: claim.invoiceId,
      exceptionType: f.type, severity: f.severity, detail: f.detail,
      expectedAmountMinor: claim.approvedAmountMinor, actualAmountMinor: settledTotal,
      byUserId: input.byUserId,
    }));
  }

  return {
    claimId: claim.id,
    claimedMinor: claim.submittedAmountMinor,
    approvedMinor: claim.approvedAmountMinor,
    settledMinor: settledTotal,
    outstandingMinor: (claim.approvedAmountMinor ?? 0) - settledTotal,
    settlementCount: settlements.length,
    findings,
    exceptionsRaised: created.length,
  };
}

export async function resolveException(input: {
  facilityId: string; exceptionId: string; to: string; note?: string; byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const ex = await tx.reconciliationException.findUnique({ where: { id: input.exceptionId } });
    if (!ex || ex.facilityId !== input.facilityId) throw new NotFoundError("Exception not found.");
    if (!isTransitionAllowed(EXCEPTION_TRANSITIONS, ex.status, input.to)) {
      throw new BadRequestError(`Illegal exception transition ${ex.status} -> ${input.to}.`);
    }
    if (["RESOLVED", "DISMISSED"].includes(input.to) && !input.note?.trim()) {
      throw new BadRequestError("A resolution note is required.");
    }
    const r = await tx.reconciliationException.updateMany({
      where: { id: ex.id, status: ex.status, version: ex.version },
      data: {
        status: input.to, resolutionNote: input.note, resolvedByUserId: input.byUserId,
        resolvedAt: ["RESOLVED", "DISMISSED"].includes(input.to) ? new Date() : null,
        version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new ConflictError("That exception changed concurrently.");
    return tx.reconciliationException.findUniqueOrThrow({ where: { id: ex.id } });
  });
}

export async function listExceptions(args: { facilityId: string; status?: string }) {
  return prisma.reconciliationException.findMany({
    where: { facilityId: args.facilityId, ...(args.status ? { status: args.status } : {}) },
    orderBy: [{ severity: "desc" }, { detectedAt: "desc" }],
    take: 200,
  });
}
