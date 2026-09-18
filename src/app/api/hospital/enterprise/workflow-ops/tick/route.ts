import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { tickWorkflows } from "@/lib/workflows";
import { requireWorkflowPlatform } from "@/lib/workflows";
import "@/lib/workflows/register";

/**
 * POST: platform-only bounded engine tick — fire due timers (SLA escalations,
 * delays) and advance RUNNABLE instances. Bounded by batchSize; no daemon required.
 * A scheduler/worker/operator drives this; correctness never depends on it running.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:operate");
    requireWorkflowPlatform(m);
    const body = await req.json().catch(() => ({}));
    const batchSize = Number.isFinite(body?.batchSize) ? Number(body.batchSize) : undefined;
    return tickWorkflows({ batchSize });
  });
}
