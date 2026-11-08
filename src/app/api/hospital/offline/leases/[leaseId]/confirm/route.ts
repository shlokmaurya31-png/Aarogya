import { NextRequest } from "next/server";
import { ForbiddenError, withApiErrors } from "@/lib/auth/rbac";
import { requireNurse } from "@/lib/hospital/offline/actor";
import { NotChargeNurseError } from "@/lib/hospital/offline/service";
import { confirmOverride } from "@/lib/hospital/offline/queue";

/** POST { reason }: the ward's charge nurse confirms in person a dose taken over from a device (audited). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ leaseId: string }> }) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    try {
      return await confirmOverride(await requireNurse(body?.facilityId), (await params).leaseId, body);
    } catch (e) {
      if (e instanceof NotChargeNurseError) throw new ForbiddenError("medication:administer");
      throw e;
    }
  });
}
