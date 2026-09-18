import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { listCollections, recordCollectionActivity, listCollectionActivity } from "@/lib/commercial/analytics/collections";

/** GET: platform collections queue, or one org's activity (?organizationId). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:read");
    const q = req.nextUrl.searchParams;
    const organizationId = q.get("organizationId");
    if (organizationId) return { activity: await listCollectionActivity(m, organizationId) };
    return { collections: await listCollections(m, { onlyAttention: q.get("onlyAttention") === "true" }) };
  });
}

const schema = z.object({
  organizationId: z.string().min(1),
  type: z.enum(["NOTE", "CONTACT", "PROMISE_TO_PAY", "ESCALATION"]),
  note: z.string().min(1).max(2000),
});

/** POST: record a manual collections activity note (platform-only; never touches money). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    return { activity: await recordCollectionActivity(m, parsed.data) };
  });
}
