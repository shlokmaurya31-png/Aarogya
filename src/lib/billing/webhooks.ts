import { Prisma, type BillingProviderKind } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { getProvider } from "./provider";
import { recordPayment } from "./payments";
import { refreshInvoicePaymentStatus } from "./invoices";
import { applyPaidRenewal } from "@/lib/commercial/subscriptions";
import { canTransitionAttempt } from "./paymentState";

/**
 * Phase D4 — productionized provider webhook ingestion.
 *
 * Pipeline: raw request -> signature verification -> normalization -> idempotency
 * -> trusted claim -> domain effect -> reconciliation if required. NEVER
 * webhook -> blind database update, and never trusted before verification.
 *
 * - Signature is checked over the exact raw body (constant-time compare in the
 *   adapters). An unverified event is REJECTED and keyed by payload hash, never
 *   its claimed id (so a spoofed same-id event cannot suppress a real one).
 * - Idempotent on (providerKind, externalEventId) via a guarded
 *   RECEIVED/VERIFIED -> PROCESSED claim wrapped around the effect in one
 *   transaction: the same event delivered N times (or concurrently) applies once.
 * - Ordering is NOT trusted. State transitions are guarded by the payment state
 *   machine; a stale/duplicate event that would move canonical state backwards is
 *   ignored and (where it signals a genuine divergence) routed to reconciliation.
 * - For the async provider model (Razorpay), a verified `payment.captured` for a
 *   known order records the canonical payment and advances renewal. An unknown
 *   reference is reconciled, never fabricated.
 * - Only a payload HASH + normalized fields are stored — never the raw body or any
 *   secret.
 */

function rawEnum(v: BillingProviderKind): Prisma.Sql {
  if (v !== "NONE" && v !== "FAKE" && v !== "RAZORPAY") throw new Error("Invalid provider kind.");
  return Prisma.raw(`'${v}'`);
}

const CAPTURE_EVENTS = new Set(["payment.captured", "payment.succeeded", "order.paid"]);
const FAIL_EVENTS = new Set(["payment.failed"]);

export interface IngestResult {
  status: "PROCESSED" | "DUPLICATE" | "REJECTED" | "RECONCILE" | "IGNORED";
  detail?: string;
}

export async function ingestWebhook(input: { providerKind: BillingProviderKind; payload: string; signature: string; eventIdHint?: string }): Promise<IngestResult> {
  const provider = getProvider(input.providerKind);
  const payloadHash = createHash("sha256").update(input.payload).digest("hex");

  // 1. Authenticity.
  const verified = provider.verifyWebhook({ payload: input.payload, signature: input.signature });
  if (!verified) {
    const rejectedKey = `rejected:${payloadHash}`;
    await prisma.$executeRaw`
      INSERT INTO "BillingWebhookEvent" (id, "providerKind", "externalEventId", "eventType", "payloadHash", "signatureVerified", status, "lastErrorCode")
      VALUES (${randomUUID()}, ${rawEnum(input.providerKind)}, ${rejectedKey}, ${"unknown"}, ${payloadHash}, ${false}, ${Prisma.raw("'REJECTED'")}, ${"SIGNATURE_INVALID"})
      ON CONFLICT ("providerKind", "externalEventId") DO NOTHING
    `;
    await recordAuditEvent("commercial.billing.webhookRejected", null, { reason: "SIGNATURE_INVALID" });
    return { status: "REJECTED", detail: "signature verification failed" };
  }

  // 2. Normalize.
  const event = provider.parseWebhook(input.payload, input.eventIdHint);

  // 3. Idempotency anchor (verified).
  await prisma.$executeRaw`
    INSERT INTO "BillingWebhookEvent" (id, "providerKind", "externalEventId", "eventType", "normalizedType", "providerResourceRef", "payloadHash", "signatureVerified", "verifiedAt", status)
    VALUES (${randomUUID()}, ${rawEnum(input.providerKind)}, ${event.externalEventId}, ${event.eventType}, ${event.eventType}, ${event.providerResourceRef ?? event.providerPaymentRef ?? null}, ${payloadHash}, ${true}, ${new Date()}, ${Prisma.raw("'VERIFIED'")})
    ON CONFLICT ("providerKind", "externalEventId") DO NOTHING
  `;
  await recordAuditEvent("commercial.billing.webhookReceived", null, { eventType: event.eventType, externalEventId: event.externalEventId });

  // 4 + 5. Claim + apply, exactly once.
  return prisma.$transaction(async (tx) => {
    const claim = await tx.billingWebhookEvent.updateMany({
      where: { providerKind: input.providerKind, externalEventId: event.externalEventId, status: { in: ["RECEIVED", "VERIFIED"] } },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
    if (claim.count !== 1) return { status: "DUPLICATE" as const, detail: "already processed" };

    let result: IngestResult = { status: "PROCESSED" };

    if (CAPTURE_EVENTS.has(event.eventType)) {
      if (event.providerResourceRef) {
        // Async model: locate the ATTEMPT by its request/order reference.
        result = await applyCapture(tx, input.providerKind, event);
      } else if (event.providerPaymentRef) {
        // Synchronous-confirmation model (payment already recorded by our flow).
        const payment = await tx.billingPayment.findFirst({ where: { providerPaymentRef: event.providerPaymentRef } });
        if (!payment) {
          await flag(tx, "UNKNOWN_REFERENCE", input.providerKind, event, "captured event for an unknown payment reference");
          result = { status: "RECONCILE", detail: "unknown provider payment reference" };
        }
      }
    } else if (FAIL_EVENTS.has(event.eventType)) {
      result = await applyFailure(tx, event);
    } else {
      result = { status: "IGNORED", detail: `no handler for ${event.eventType}` };
    }

    await tx.billingWebhookEvent.update({
      where: { providerKind_externalEventId: { providerKind: input.providerKind, externalEventId: event.externalEventId } },
      data: { processingResult: result.status, lastErrorMessage: result.detail ?? null },
    });
    await recordAuditEvent("commercial.billing.webhookProcessed", null, { eventType: event.eventType, externalEventId: event.externalEventId, result: result.status }, undefined, tx);
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });
}

/** Record a captured payment against the attempt's invoice, advancing renewal if applicable. */
async function applyCapture(tx: Prisma.TransactionClient, providerKind: BillingProviderKind, event: { providerResourceRef?: string; providerPaymentRef?: string; amountMinor?: number }): Promise<IngestResult> {
  const attempt = await tx.billingPaymentAttempt.findFirst({ where: { providerRequestRef: event.providerResourceRef } });
  if (!attempt) {
    await flag(tx, "UNKNOWN_REFERENCE", providerKind, event, "captured event for an unknown order/request reference");
    return { status: "RECONCILE", detail: "unknown order reference" };
  }
  if (attempt.status === "SUCCEEDED") return { status: "DUPLICATE", detail: "attempt already succeeded" };
  if (!canTransitionAttempt(attempt.status, "SUCCEEDED")) {
    await flag(tx, "STATE_MISMATCH", providerKind, event, `capture cannot move attempt from ${attempt.status}`);
    return { status: "RECONCILE", detail: "illegal attempt transition" };
  }
  // Amount cross-check — the server amount is authoritative; a mismatch reconciles.
  if (event.amountMinor != null && event.amountMinor !== attempt.amountMinor) {
    await flag(tx, "STATE_MISMATCH", providerKind, event, `captured amount ${event.amountMinor} != attempt ${attempt.amountMinor}`);
    return { status: "RECONCILE", detail: "amount mismatch" };
  }

  await tx.billingPaymentAttempt.updateMany({
    where: { id: attempt.id, status: { in: ["INITIATED", "PENDING"] } },
    data: { status: "SUCCEEDED", providerPaymentRef: event.providerPaymentRef ?? null },
  });
  await recordPayment(tx, {
    invoiceId: attempt.invoiceId, attemptId: attempt.id, amountMinor: attempt.amountMinor,
    idempotencyKey: `whpay:${event.providerPaymentRef ?? event.providerResourceRef}`,
    providerKind, providerPaymentRef: event.providerPaymentRef ?? null, method: "provider", createdByUserId: null,
  });
  await refreshInvoicePaymentStatus(tx, attempt.invoiceId);

  // If this invoice is a renewal invoice now fully paid, advance the subscription.
  const invoice = await tx.billingInvoice.findUniqueOrThrow({ where: { id: attempt.invoiceId } });
  if (invoice.status === "PAID" && invoice.billingPeriodId && invoice.subscriptionId) {
    const period = await tx.billingPeriod.findUnique({ where: { id: invoice.billingPeriodId } });
    if (period) {
      await applyPaidRenewal(tx, invoice.organizationId, { periodStart: period.periodStart, periodEnd: period.periodEnd });
      await tx.billingPeriod.update({ where: { id: period.id }, data: { status: "INVOICED" } });
    }
  }
  return { status: "PROCESSED" };
}

/** Mark the attempt failed. Dunning is handled separately (processBillingDunning). */
async function applyFailure(tx: Prisma.TransactionClient, event: { providerResourceRef?: string; failureCode?: string }): Promise<IngestResult> {
  if (!event.providerResourceRef) return { status: "IGNORED", detail: "failure event without order reference" };
  const attempt = await tx.billingPaymentAttempt.findFirst({ where: { providerRequestRef: event.providerResourceRef } });
  if (!attempt) return { status: "IGNORED", detail: "failure for unknown order" };
  if (!canTransitionAttempt(attempt.status, "FAILED")) return { status: "DUPLICATE", detail: "attempt no longer pending" };
  await tx.billingPaymentAttempt.updateMany({
    where: { id: attempt.id, status: { in: ["INITIATED", "PENDING"] } },
    data: { status: "FAILED", failureCode: event.failureCode ?? "failed", failureReason: event.failureCode ?? "failed" },
  });
  return { status: "PROCESSED", detail: "attempt marked failed" };
}

async function flag(tx: Prisma.TransactionClient, kind: "UNKNOWN_REFERENCE" | "STATE_MISMATCH", providerKind: BillingProviderKind, event: { providerResourceRef?: string; providerPaymentRef?: string }, description: string) {
  await tx.billingReconciliationException.create({
    data: {
      kind, providerKind, severity: "HIGH", entityType: "webhook", description,
      providerRef: event.providerResourceRef ?? event.providerPaymentRef ?? null,
    },
  });
}
