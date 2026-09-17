import { Prisma, type BillingProviderKind } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { getProvider } from "./provider";

/**
 * Phase D3 — provider webhook ingestion.
 *
 * The pipeline is strict:
 *   verify signature -> normalize -> idempotency -> canonical event -> domain
 *   transition. NEVER webhook -> blind database update.
 *
 * - An unverified signature is REJECTED and never applied.
 * - Idempotent on (providerKind, externalEventId): the same event delivered N
 *   times (or concurrently) is processed at most once, via a guarded
 *   RECEIVED -> PROCESSED claim wrapped around the domain effect in one
 *   transaction, so a lost race simply no-ops.
 * - Ordering is NOT trusted: an event referencing an unknown payment raises a
 *   reconciliation exception instead of fabricating state.
 * - Only a payload HASH is stored, never the raw sensitive body or any secret.
 */

function rawEnum(v: BillingProviderKind): Prisma.Sql {
  if (v !== "NONE" && v !== "FAKE") throw new Error("Invalid provider kind.");
  return Prisma.raw(`'${v}'`);
}

export interface IngestResult {
  status: "PROCESSED" | "DUPLICATE" | "REJECTED" | "RECONCILE";
  detail?: string;
}

export async function ingestWebhook(input: { providerKind: BillingProviderKind; payload: string; signature: string }): Promise<IngestResult> {
  const provider = getProvider(input.providerKind);
  const payloadHash = createHash("sha256").update(input.payload).digest("hex");

  // 1. Authenticity. A bad signature is recorded (for visibility) and rejected.
  const verified = provider.verifyWebhook({ payload: input.payload, signature: input.signature });
  if (!verified) {
    // A rejected event is recorded under a NON-authoritative key derived from the
    // payload hash — NEVER the claimed externalEventId. Trusting the claimed id
    // here would let an attacker pre-register (and thereby suppress) a real event
    // by first sending a same-id event with a bad signature.
    const rejectedKey = `rejected:${payloadHash}`;
    await prisma.$executeRaw`
      INSERT INTO "BillingWebhookEvent" (id, "providerKind", "externalEventId", "eventType", "payloadHash", "signatureVerified", status)
      VALUES (${randomUUID()}, ${rawEnum(input.providerKind)}, ${rejectedKey}, ${"unknown"}, ${payloadHash}, ${false}, ${Prisma.raw("'REJECTED'")})
      ON CONFLICT ("providerKind", "externalEventId") DO NOTHING
    `;
    await recordAuditEvent("commercial.billing.webhookRejected", null, { reason: "SIGNATURE_INVALID" });
    return { status: "REJECTED", detail: "signature verification failed" };
  }

  // 2. Normalize.
  const event = provider.parseWebhook(input.payload);

  // 3. Idempotency anchor: materialise the event row once.
  await prisma.$executeRaw`
    INSERT INTO "BillingWebhookEvent" (id, "providerKind", "externalEventId", "eventType", "payloadHash", "signatureVerified", status)
    VALUES (${randomUUID()}, ${rawEnum(input.providerKind)}, ${event.externalEventId}, ${event.eventType}, ${payloadHash}, ${true}, ${Prisma.raw("'VERIFIED'")})
    ON CONFLICT ("providerKind", "externalEventId") DO NOTHING
  `;
  await recordAuditEvent("commercial.billing.webhookReceived", null, { eventType: event.eventType, externalEventId: event.externalEventId });

  // 4 + 5. Claim + apply in one transaction. Exactly-once via the guarded claim.
  return prisma.$transaction(async (tx) => {
    const claim = await tx.billingWebhookEvent.updateMany({
      where: { providerKind: input.providerKind, externalEventId: event.externalEventId, status: { in: ["RECEIVED", "VERIFIED"] } },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
    if (claim.count !== 1) return { status: "DUPLICATE" as const, detail: "already processed" };

    let result: IngestResult = { status: "PROCESSED" };

    // Domain transition — ordering is not trusted; unknown refs reconcile.
    if (event.providerPaymentRef && (event.eventType === "payment.succeeded" || event.eventType === "payment.failed")) {
      const payment = await tx.billingPayment.findFirst({ where: { providerPaymentRef: event.providerPaymentRef } });
      if (!payment) {
        // We do not fabricate a payment from a webhook. Flag for reconciliation.
        await tx.billingReconciliationException.create({
          data: { kind: "UNKNOWN_REFERENCE", providerKind: input.providerKind, providerRef: event.providerPaymentRef, detail: { eventType: event.eventType } },
        });
        result = { status: "RECONCILE", detail: "unknown provider payment reference" };
      }
      // If the payment IS known, our synchronous flow already recorded its state;
      // the webhook is a confirmation and needs no blind mutation.
    }

    await tx.billingWebhookEvent.update({ where: { providerKind_externalEventId: { providerKind: input.providerKind, externalEventId: event.externalEventId } }, data: { processingResult: result.status } });
    await recordAuditEvent("commercial.billing.webhookProcessed", null, { eventType: event.eventType, externalEventId: event.externalEventId, result: result.status }, undefined, tx);
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });
}
