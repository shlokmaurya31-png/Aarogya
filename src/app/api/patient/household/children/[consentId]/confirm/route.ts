import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { confirmAddMinor } from "@/lib/household/households";

/** POST { code } — parental consent, step 2: the child's profile is created (Week 5b). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ consentId: string }> }) {
  return withApiErrors(async () => confirmAddMinor((await patientSession()).userId, (await params).consentId, (await req.json().catch(() => ({})))?.code));
}
