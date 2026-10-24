import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { confirmOwnCode } from "@/lib/household/dependentConsent";

/** POST { code } — the code the dependent adult gave you (Week 5b). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ consentId: string }> }) {
  return withApiErrors(async () => confirmOwnCode((await patientSession()).userId, (await params).consentId, (await req.json().catch(() => ({})))?.code));
}
