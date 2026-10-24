import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { inviteLinkedAdult } from "@/lib/household/households";

/** POST { email } — invite an adult with their own account (the same answer whether or not it exists) (Week 5b). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => inviteLinkedAdult((await patientSession()).userId, (await params).id, (await req.json().catch(() => ({})))?.email));
}
