import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { cancelInstance } from "@/lib/workflows";

/** POST: cancel a workflow instance (platform-only, audited). Body: { reason }. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ instanceId: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:operate");
    const { instanceId } = await params;
    const body = await req.json().catch(() => ({}));
    return { instance: await cancelInstance(m, instanceId, body?.reason ?? "cancelled by operator") };
  });
}
