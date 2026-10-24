import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { removeMember } from "@/lib/household/households";

/** POST — leave (yourself) or remove (a manager) a member (Week 5b). */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ memberId: string }> }) {
  return withApiErrors(async () => removeMember((await patientSession()).userId, (await params).memberId));
}
