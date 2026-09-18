import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { listDeadLetters } from "@/lib/events";

/** GET: platform-only dead-letter queue (event + its dead-lettered deliveries). */
export async function GET() {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("platform:events:operate");
    return { deadLetters: await listDeadLetters(m) };
  });
}
