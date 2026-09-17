import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { refundPayment, refundViaProvider } from "@/lib/billing/refunds";

/**
 * Platform-only: refund (part of) a payment. Cannot exceed the payment's
 * un-refunded balance; idempotent on idempotencyKey; amount is server-
 * authoritative. When providerKind is FAKE/RAZORPAY the refund is executed
 * through the provider (with distributed-failure reconciliation); otherwise it is
 * a domain/out-of-band refund.
 */
const schema = z.object({
  paymentId: z.string().min(1),
  amountMinor: z.number().int().positive(),
  reason: z.string().min(1),
  idempotencyKey: z.string().min(8),
  providerKind: z.enum(["FAKE", "RAZORPAY"]).optional(),
});

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    const { providerKind, ...rest } = parsed.data;
    const refund = providerKind
      ? await refundViaProvider(m, { ...rest, providerKind })
      : await refundPayment(m, rest);
    return { refund };
  });
}
