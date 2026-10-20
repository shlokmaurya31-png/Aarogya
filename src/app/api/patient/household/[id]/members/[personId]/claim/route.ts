import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { startClaimOwnContact } from "@/lib/household/comingOfAge";

/** POST — hand a profile over: a claim code to the member's own verified contact (Week 5b). */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string; personId: string }> }) {
  return withApiErrors(async () => {
    const { id, personId } = await params;
    return startClaimOwnContact((await patientSession()).userId, id, personId);
  });
}
