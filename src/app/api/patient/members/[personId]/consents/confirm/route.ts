import { NextRequest } from "next/server";
import { BadRequestError, withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { confirmGuardianConsent } from "@/lib/household/guardianConsent";

/** POST { checkId, code } — confirms a guardian's choice for a managed child (Week 5b). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const s = await patientSession();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.checkId !== "string") throw new BadRequestError("checkId is required.");
    return confirmGuardianConsent(s.userId, body.checkId, body.code);
  });
}
