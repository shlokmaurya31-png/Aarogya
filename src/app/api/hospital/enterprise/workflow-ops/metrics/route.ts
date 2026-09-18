import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { getWorkflowMetrics } from "@/lib/workflows";

/** GET: platform-only workflow-engine operational metrics. */
export async function GET() {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:operate");
    return getWorkflowMetrics(m);
  });
}
