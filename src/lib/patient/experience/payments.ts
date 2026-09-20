import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { isProviderConfigured } from "@/lib/billing/provider/config";
import { outstandingMinor } from "./billing";
import type { PatientAccessScope } from "../context";

/**
 * Phase D11 — patient payment boundary (brief §24, §50).
 *
 * THE most security-sensitive patient flow. Non-negotiable rules, all enforced
 * here and proven by the D11 gate:
 *   • The amount is ALWAYS computed server-side from the canonical Invoice
 *     (total − allocated). A browser-supplied amount/currency/patientId is
 *     never trusted — it is not even read.
 *   • A patient may only pay their OWN invoice (scope.isSelf + ownership check).
 *   • An invoice is NEVER marked paid on a browser "success=true". The only path
 *     to a canonical Payment is a provider-verified callback (recordPayment +
 *     allocatePayment), which does not exist until a real gateway is wired.
 *   • No hospital-patient payment gateway is configured (Razorpay creds are an
 *     external blocker), so initiation honestly returns PROVIDER_NOT_CONFIGURED
 *     and confirmation refuses. We never simulate a successful external payment.
 */

export type PaymentInitResult =
  | { status: "PROVIDER_NOT_CONFIGURED"; invoiceId: string; amountMinor: number; currency: string }
  | { status: "READY"; invoiceId: string; amountMinor: number; currency: string; providerOrder: { provider: string } };

/**
 * Server resolves the invoice and the amount. `input` intentionally carries ONLY
 * an invoiceId — never an amount. If a client sends an amount, it is ignored.
 */
export async function initiatePatientPayment(
  scope: PatientAccessScope,
  input: { invoiceId: string },
): Promise<PaymentInitResult> {
  if (!scope.isSelf) throw new NotFoundError();
  const invoice = await prisma.invoice.findUnique({
    where: { id: input.invoiceId },
    select: { id: true, patientId: true, status: true, totalMinor: true, allocatedMinor: true, currency: true },
  });
  // Not ours / nonexistent => 404-shaped. A patient can never probe or pay
  // another patient's invoice (brief §50).
  if (!invoice || !scope.patientIds.includes(invoice.patientId)) throw new NotFoundError();

  const amountMinor = outstandingMinor(invoice);
  if (amountMinor <= 0) throw new BadRequestError("This invoice has nothing outstanding to pay.");

  // Honest external-dependency boundary. Razorpay for the HOSPITAL revenue cycle
  // is not wired (creds blocked); we implement the correct internal contract and
  // surface the unavailable state rather than faking a provider order.
  if (!isProviderConfigured("RAZORPAY")) {
    return { status: "PROVIDER_NOT_CONFIGURED", invoiceId: invoice.id, amountMinor, currency: invoice.currency };
  }
  // If a provider were configured, the order would be created here from the
  // server-computed amountMinor (never a client amount). Left unreachable until a
  // verified gateway integration + webhook exists — we do not ship an unverified
  // capture path.
  return {
    status: "READY",
    invoiceId: invoice.id,
    amountMinor,
    currency: invoice.currency,
    providerOrder: { provider: "RAZORPAY" },
  };
}

/**
 * Patient-side confirmation. Deliberately refuses to mark anything paid: a
 * browser callback is not proof of payment. The canonical Payment is only ever
 * created by a provider-verified server-to-server callback (the existing billing
 * webhook verification mechanism), which is not wired for hospital payments yet.
 * Any client-asserted success is rejected here — this is the anti-forgery guard.
 */
export function confirmPatientPayment(): never {
  throw new BadRequestError(
    "A payment cannot be confirmed from the browser. It is only recorded after the payment provider verifies it server-side, which is not available yet (EXTERNAL_VERIFICATION_REQUIRED).",
  );
}
