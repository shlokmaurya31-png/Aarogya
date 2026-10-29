import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { issuePack } from "@/lib/hospital/offline/service";
import { requireNurse } from "@/lib/hospital/offline/actor";

/** POST { deviceId, deviceClock? }: the offline ward pack for the nurse on this device, and its dose leases. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    return issuePack(await requireNurse(body?.facilityId), body);
  });
}
