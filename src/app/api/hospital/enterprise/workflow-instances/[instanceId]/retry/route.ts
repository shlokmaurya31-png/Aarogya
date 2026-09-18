import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { retryInstance } from "@/lib/workflows";

/** POST: manually retry/recover a FAILED workflow instance (platform-only, idempotent). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ instanceId: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:operate");
    const { instanceId } = await params;
    const body = await req.json().catch(() => ({}));
    return { instance: await retryInstance(m, instanceId, { recover: Boolean(body?.recover), reason: body?.reason }) };
  });
}
