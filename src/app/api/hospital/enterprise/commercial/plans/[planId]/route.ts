import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { updatePlan } from "@/lib/commercial/plans";

const schema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
  status: z.enum(["ACTIVE", "DEPRECATED", "RETIRED"]).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ planId: string }> }) {
  return withApiErrors(async () => {
    const { planId } = await params;
    const m = await requireActorMemberships("commercial:platform:manage");
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    return { plan: await updatePlan(m, planId, parsed.data) };
  });
}
