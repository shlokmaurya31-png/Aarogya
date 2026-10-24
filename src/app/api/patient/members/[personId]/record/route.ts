import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { viewMember } from "@/lib/household/proxy";

/** GET — a member's record as your grant allows (VIEW) (Week 5b). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ personId: string }> }) {
  return withApiErrors(async () => viewMember((await patientSession()).userId, (await params).personId));
}
