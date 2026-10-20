import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { insuranceForMember } from "@/lib/household/proxy";

/** GET — a member's insurance (INSURANCE) (Week 5b). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ personId: string }> }) {
  return withApiErrors(async () => insuranceForMember((await patientSession()).userId, (await params).personId));
}
