import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { updateBillingAccount } from "@/lib/billing/billingAccount";

/**
 * Update an organization's billing account. Contact fields are org-admin
 * self-service; currency is platform-only (enforced in the service). Never
 * accepts card/credential data.
 */
const schema = z.object({
  organizationId: z.string().min(1),
  billingName: z.string().min(1).optional(),
  billingEmail: z.string().email().optional(),
  billingAddress: z.string().optional().nullable(),
  taxId: z.string().optional().nullable(),
  currency: z.string().length(3).optional(),
});

export async function PUT(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:read");
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    const { organizationId, ...patch } = parsed.data;
    return { account: await updateBillingAccount(m, organizationId, patch) };
  });
}
