import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { setPlanEntitlement } from "@/lib/commercial/plans";

const schema = z.object({
  key: z.string().min(1),
  boolValue: z.boolean().optional().nullable(),
  numberValue: z.number().int().optional().nullable(),
  unlimited: z.boolean().optional(),
});

export async function PUT(req: NextRequest, { params }: { params: Promise<{ planId: string }> }) {
  return withApiErrors(async () => {
    const { planId } = await params;
    const m = await requireActorMemberships("commercial:platform:manage");
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    await setPlanEntitlement(m, planId, parsed.data);
    return { ok: true };
  });
}
