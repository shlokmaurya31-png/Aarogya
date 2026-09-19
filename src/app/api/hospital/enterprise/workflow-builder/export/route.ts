import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { exportWorkflow } from "@/lib/workflow-builder";

/** GET: export a published/draft workflow version as a portable document (no secrets). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:read");
    const sp = new URL(req.url).searchParams;
    const workflowId = sp.get("workflowId");
    if (!workflowId) throw new BadRequestError("workflowId is required.");
    return exportWorkflow(m, workflowId, sp.get("versionId") ?? undefined);
  });
}
