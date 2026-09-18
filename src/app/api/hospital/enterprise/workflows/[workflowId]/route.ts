import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { getDefinition } from "@/lib/workflows";

/** GET: a workflow definition with its versions (scoped read). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ workflowId: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:read");
    const { workflowId } = await params;
    return { definition: await getDefinition(m, workflowId) };
  });
}
