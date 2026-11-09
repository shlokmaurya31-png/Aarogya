import { NextRequest } from "next/server";
import { ForbiddenError, withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { revokeClinicalSignOff } from "@/lib/hospital/offline/switch";

/** POST { reason }: platform staff revoke the sign-off; every ward's offline mode turns off. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ signOffId: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("platform:clinical-sign-off:record");
    if (!m.isPlatformAdmin) throw new ForbiddenError("platform:clinical-sign-off:record");
    return revokeClinicalSignOff({ userId: m.userId }, (await params).signOffId, await req.json().catch(() => ({})));
  });
}
