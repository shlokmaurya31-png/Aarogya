import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { publishVersion } from "@/lib/workflows";

/** POST: publish a DRAFT version (platform-only, race-safe). Body: { versionId }. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ workflowId: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:manage");
    const { workflowId } = await params;
    const body = await req.json().catch(() => ({}));
    return { definition: await publishVersion(m, workflowId, body?.versionId) };
  });
}
