import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { getInvoice } from "@/lib/billing/invoices";

/** Tenant-scoped single invoice with lines, payments and applied credits. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:read");
    const { id } = await ctx.params;
    return { invoice: await getInvoice(m, id) };
  });
}
