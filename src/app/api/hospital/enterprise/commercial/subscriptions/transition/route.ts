import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { transitionSubscription, cancelSubscription } from "@/lib/commercial/subscriptions";

/**
 * Subscription lifecycle actions (platform-only): a declared state transition,
 * or a cancellation (at period end or immediate).
 */
const schema = z.object({
  organizationId: z.string().min(1),
  action: z.enum(["transition", "cancel"]),
  to: z.enum(["TRIAL", "ACTIVE", "PAST_DUE", "GRACE", "SUSPENDED", "CANCELLED", "EXPIRED"]).optional(),
  immediate: z.boolean().optional(),
  reason: z.string().optional(),
});

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    const { organizationId, action } = parsed.data;
    if (action === "cancel") {
      return { subscription: await cancelSubscription(m, organizationId, { immediate: parsed.data.immediate, reason: parsed.data.reason }) };
    }
    if (!parsed.data.to) throw new BadRequestError("`to` is required for a transition.");
    return { subscription: await transitionSubscription(m, organizationId, parsed.data.to, parsed.data.reason) };
  });
}
