import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { bookForMember } from "@/lib/household/proxy";

/** POST { locationId, start, mode?, reason?, share? } — book through the directory for a member (BOOK; a share needs SHARE) (Week 5b). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ personId: string }> }) {
  return withApiErrors(async () => bookForMember((await patientSession()).userId, (await params).personId, await req.json().catch(() => ({}))));
}
