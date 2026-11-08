import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { renewLeases } from "@/lib/hospital/offline/service";
import { requireNurse } from "@/lib/hospital/offline/actor";

/** POST { deviceId, packId }: extend the device's live leases while it is online. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    return renewLeases(await requireNurse(body?.facilityId), body);
  });
}
