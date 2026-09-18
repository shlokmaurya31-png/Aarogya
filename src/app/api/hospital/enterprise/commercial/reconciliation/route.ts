import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { getReconciliationDashboard, listExceptions, listOrganizationExceptions, assignException, transitionException } from "@/lib/commercial/analytics/reconciliationIntel";

/**
 * GET: reconciliation intelligence — dashboard (default, platform), platform list
 * (?view=list), or an organization's own exceptions (?organizationId, tenant).
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:read");
    const q = req.nextUrl.searchParams;
    const organizationId = q.get("organizationId");
    if (organizationId) return { exceptions: await listOrganizationExceptions(m, organizationId) };
    if (q.get("view") === "list") return { exceptions: await listExceptions(m, { status: q.get("status") ?? undefined, source: q.get("source") ?? undefined }) };
    return getReconciliationDashboard(m);
  });
}

const schema = z.union([
  z.object({ action: z.literal("assign"), id: z.string().min(1), assignedToUserId: z.string().min(1) }),
  z.object({ action: z.literal("transition"), id: z.string().min(1), to: z.enum(["ACKNOWLEDGED", "RESOLVED", "DISMISSED"]), resolution: z.string().max(2000).optional() }),
]);

/** POST: platform-only triage (assign / acknowledge / resolve / dismiss). Never mutates money. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError("Invalid input.");
    if (parsed.data.action === "assign") return { exception: await assignException(m, parsed.data.id, parsed.data.assignedToUserId) };
    return { exception: await transitionException(m, parsed.data.id, parsed.data.to, parsed.data.resolution) };
  });
}
