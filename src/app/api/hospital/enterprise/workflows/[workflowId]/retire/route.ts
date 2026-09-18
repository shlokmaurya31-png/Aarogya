import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { retireDefinition } from "@/lib/workflows";

/** POST: retire a definition — no new instances will be triggered (platform-only). */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ workflowId: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:manage");
    const { workflowId } = await params;
    return { definition: await retireDefinition(m, workflowId) };
  });
}
