import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { getInstance } from "@/lib/workflows";

/** GET: a workflow instance with its steps, tasks and timers (scoped read). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ instanceId: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:read");
    const { instanceId } = await params;
    return { instance: await getInstance(m, instanceId) };
  });
}
