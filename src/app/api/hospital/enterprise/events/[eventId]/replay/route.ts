import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { replayEvent } from "@/lib/events";

/** POST: platform-only controlled replay of an event (audited, idempotent). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("platform:events:operate");
    const { eventId } = await params;
    const body = await req.json().catch(() => ({}));
    return replayEvent(m, eventId, { consumerName: body?.consumerName, reason: body?.reason });
  });
}
