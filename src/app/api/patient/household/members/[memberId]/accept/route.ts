import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { acceptInvitation } from "@/lib/household/households";

/** POST { permissions?, categories? } — accept an invitation, choosing what the managers may do (or nothing) (Week 5b). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ memberId: string }> }) {
  return withApiErrors(async () => acceptInvitation((await patientSession()).userId, (await params).memberId, await req.json().catch(() => ({}))));
}
