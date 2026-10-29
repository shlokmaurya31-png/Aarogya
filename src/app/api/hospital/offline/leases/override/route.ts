import { NextRequest } from "next/server";
import { ForbiddenError, withApiErrors } from "@/lib/auth/rbac";
import { NotChargeNurseError, overrideLease } from "@/lib/hospital/offline/service";
import { requireNurse } from "@/lib/hospital/offline/actor";

/** POST { administrationId, reason }: the ward's charge nurse takes a dose over from a device (logged with the reason). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    try {
      return await overrideLease(await requireNurse(body?.facilityId), body);
    } catch (e) {
      if (e instanceof NotChargeNurseError) throw new ForbiddenError("medication:administer");
      throw e;
    }
  });
}
