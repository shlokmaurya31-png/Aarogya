import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { voidInvoice } from "@/lib/billing/invoices";

const schema = z.object({ reason: z.string().min(1) });

/** Platform-only: void an invoice that has taken no money. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    const { id } = await ctx.params;
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "A reason is required.");
    return { invoice: await voidInvoice(m, id, parsed.data.reason) };
  });
}
