import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { listPlans, createPlan } from "@/lib/commercial/plans";

/** The plan catalogue (readable by any commercial reader) and plan creation (platform). */
export async function GET() {
  return withApiErrors(async () => {
    await requireActorMemberships("commercial:read");
    return { plans: await listPlans() };
  });
}

const createSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  billingInterval: z.enum(["MONTHLY", "QUARTERLY", "YEARLY", "NONE"]).optional(),
});

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    return { plan: await createPlan(m, parsed.data) };
  });
}
