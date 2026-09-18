import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { listInstances } from "@/lib/workflows";

/** GET: list workflow instances (scoped: platform sees all, org admin sees own org). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:read");
    const sp = new URL(req.url).searchParams;
    return {
      instances: await listInstances(m, {
        organizationId: sp.get("organizationId") ?? undefined,
        status: sp.get("status") ?? undefined,
        workflowDefinitionId: sp.get("workflowId") ?? undefined,
      }),
    };
  });
}
