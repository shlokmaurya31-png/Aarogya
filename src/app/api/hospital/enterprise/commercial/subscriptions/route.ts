import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { assignPlan } from "@/lib/commercial/subscriptions";

/** Assign (create or replace) an organization's subscription to a plan. Platform-only. */
const schema = z.object({
  organizationId: z.string().min(1),
  planCode: z.string().min(1),
  trial: z.boolean().optional(),
  trialDays: z.number().int().positive().optional(),
  isDefault: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    return { subscription: await assignPlan(m, parsed.data) };
  });
}
