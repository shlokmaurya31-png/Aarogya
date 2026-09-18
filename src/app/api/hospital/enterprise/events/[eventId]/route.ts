import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { getEvent } from "@/lib/events";

/** GET: platform-only single event with its per-consumer delivery records. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("platform:events:operate");
    const { eventId } = await params;
    return { event: await getEvent(m, eventId) };
  });
}
