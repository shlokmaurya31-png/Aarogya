import { NextRequest } from "next/server";
import { ForbiddenError, withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { activeSignOff, recordClinicalSignOff } from "@/lib/hospital/offline/switch";

/** GET: the active sign-off of the offline rules, or none (platform staff). */
export async function GET() {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("platform:clinical-sign-off:record");
    if (!m.isPlatformAdmin) throw new ForbiddenError("platform:clinical-sign-off:record");
    return { signOff: await activeSignOff() };
  });
}

/** POST { advisorName, reference, signedOffAt }: platform staff record the clinical advisor's sign-off of the offline rules (§6). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("platform:clinical-sign-off:record");
    if (!m.isPlatformAdmin) throw new ForbiddenError("platform:clinical-sign-off:record");
    const s = await recordClinicalSignOff({ userId: m.userId }, await req.json().catch(() => ({})));
    return { signOff: { id: s.id, scope: s.scope, signedOffAt: s.signedOffAt } };
  });
}
