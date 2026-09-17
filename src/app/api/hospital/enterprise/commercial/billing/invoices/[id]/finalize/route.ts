import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { finalizeInvoice } from "@/lib/billing/invoices";

/** Platform-only: finalize a DRAFT invoice (assign number, freeze, open). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    const { id } = await ctx.params;
    return { invoice: await finalizeInvoice(m, id) };
  });
}
