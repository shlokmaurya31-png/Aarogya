import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { createVersion } from "@/lib/workflows";

/** POST: create a new DRAFT version of a definition (platform-only). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ workflowId: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:manage");
    const { workflowId } = await params;
    const body = await req.json().catch(() => ({}));
    return { version: await createVersion(m, workflowId, body?.config) };
  });
}
