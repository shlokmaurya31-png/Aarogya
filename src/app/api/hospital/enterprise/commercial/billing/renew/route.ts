import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { renewSubscription } from "@/lib/billing/renewal";

/**
 * Platform-only: run one renewal cycle. providerKind selects how payment is
 * executed (NONE = leave the invoice open for manual recording; FAKE = the
 * deterministic test provider). No real provider is configured in this repo.
 */
const schema = z.object({
  organizationId: z.string().min(1),
  providerKind: z.enum(["NONE", "FAKE"]).optional(),
});

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    return renewSubscription(m, parsed.data);
  });
}
