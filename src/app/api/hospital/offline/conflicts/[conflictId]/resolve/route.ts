import { NextRequest } from "next/server";
import { ForbiddenError, withApiErrors } from "@/lib/auth/rbac";
import { requireNurse } from "@/lib/hospital/offline/actor";
import { NotChargeNurseError } from "@/lib/hospital/offline/service";
import { resolveConflict } from "@/lib/hospital/offline/queue";

/** POST { resolution, reason }: the ward's charge nurse resolves an offline conflict (audited). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ conflictId: string }> }) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    try {
      const c = await resolveConflict(await requireNurse(body?.facilityId), (await params).conflictId, body);
      return { conflict: { id: c.id, status: c.status, resolution: c.resolution, resolvedAt: c.resolvedAt } };
    } catch (e) {
      if (e instanceof NotChargeNurseError) throw new ForbiddenError("medication:administer");
      throw e;
    }
  });
}
