import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { startService, completeQueueEntry, skipQueueEntry, cancelQueueEntry, QueueEntryNotWaitingError } from "@/lib/hospital/queue";

/** Queue lifecycle actions (brief §8) — start | complete | skip | cancel. "Call next" is a separate endpoint (POST /api/hospital/queue/next) since it doesn't target a specific id up front. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("queue:manage", body?.facilityId);

    const entry = await prisma.queueEntry.findUnique({ where: { id } });
    if (!entry || entry.facilityId !== facilityId) throw new NotFoundError("Queue entry not found.");

    const action = body?.action as string | undefined;
    try {
      if (action === "start") return { entry: await startService(id) };
      if (action === "complete") return { entry: await completeQueueEntry(id, session.userId) };
      if (action === "skip") return { entry: await skipQueueEntry(id) };
      if (action === "cancel") return { entry: await cancelQueueEntry(id) };
      throw new BadRequestError("Unknown action.");
    } catch (err) {
      if (err instanceof QueueEntryNotWaitingError) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
