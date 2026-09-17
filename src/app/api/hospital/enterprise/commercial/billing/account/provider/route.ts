import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { syncProviderCustomer } from "@/lib/billing/billingAccount";

/**
 * Platform-only: create/link the provider customer for an org's billing account.
 * Idempotent and safe under partial provider/local failure (reconciled). Never
 * accepts or returns credentials.
 */
const schema = z.object({
  organizationId: z.string().min(1),
  providerKind: z.enum(["FAKE", "RAZORPAY"]),
});

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    const account = await syncProviderCustomer(m, parsed.data.organizationId, parsed.data.providerKind);
    // Return only safe fields — never the raw provider reference beyond presence.
    return { account: { organizationId: account.organizationId, providerKind: account.providerKind, providerLinked: !!account.providerCustomerRef } };
  });
}
