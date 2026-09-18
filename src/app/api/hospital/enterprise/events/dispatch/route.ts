import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { dispatchPendingDomainEvents } from "@/lib/events";
// Phase D7 — ensure the workflow-engine consumer is registered before dispatch so
// committed events drive workflows. Side-effect import (workflows → events only).
import "@/lib/workflows/register";

/**
 * POST: platform-only operational trigger to dispatch pending events. Bounded by
 * batchSize + maxDurationMs so the request can never run unbounded. This exists so
 * a scheduler/worker/operator can drive the dispatcher; D6 ships no daemon and
 * correctness never depends on one running.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    await requireActorMemberships("platform:events:operate");
    const body = await req.json().catch(() => ({}));
    const batchSize = Number.isFinite(body?.batchSize) ? Number(body.batchSize) : undefined;
    return dispatchPendingDomainEvents({ batchSize, maxDurationMs: 15_000 });
  });
}
