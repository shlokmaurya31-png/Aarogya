import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { syncCommands } from "@/lib/hospital/offline/service";
import { requireNurse } from "@/lib/hospital/offline/actor";

/** POST { deviceId, commands: [{ clientOperationId, kind, administrationId, deviceTime, reasonCode? }] }: apply offline work, in order; a replay is a no-op. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    return syncCommands(await requireNurse(body?.facilityId), body);
  });
}
