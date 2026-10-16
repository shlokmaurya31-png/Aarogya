import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { listDeadLetters } from "@/lib/events";
import { listWorkflowDeadLetters } from "@/lib/workflows/ops";

/**
 * GET: platform-only dead-letter queue: events with their dead-lettered
 * deliveries, and failed workflow instances / timers (bounded retries ended).
 */
export async function GET() {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("platform:events:operate");
    return { deadLetters: await listDeadLetters(m), workflowFailures: await listWorkflowDeadLetters(m) };
  });
}
