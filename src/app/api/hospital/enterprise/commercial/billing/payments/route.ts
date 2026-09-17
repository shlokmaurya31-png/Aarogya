import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { recordManualPayment } from "@/lib/billing/payments";

/**
 * Platform-only: record a payment received out-of-band against an invoice.
 * Idempotent on idempotencyKey. The amount is server-validated against the
 * invoice balance; a client can never set the invoice total.
 */
const schema = z.object({
  invoiceId: z.string().min(1),
  amountMinor: z.number().int().positive(),
  method: z.string().optional(),
  idempotencyKey: z.string().min(8),
});

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    return { payment: await recordManualPayment(m, parsed.data) };
  });
}
