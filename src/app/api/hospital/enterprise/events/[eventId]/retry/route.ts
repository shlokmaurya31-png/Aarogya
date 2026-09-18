import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { retryDeadLetter } from "@/lib/events";

/** POST: platform-only retry of a dead-lettered event (audited). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("platform:events:operate");
    const { eventId } = await params;
    const body = await req.json().catch(() => ({}));
    return retryDeadLetter(m, eventId, { reason: body?.reason });
  });
}
