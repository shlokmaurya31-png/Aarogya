import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { sendOwnCode } from "@/lib/household/dependentConsent";

/** POST — a code to the dependent adult's own contact, for their consent (Week 5b). */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string; personId: string }> }) {
  return withApiErrors(async () => {
    const { id, personId } = await params;
    return sendOwnCode((await patientSession()).userId, id, personId);
  });
}
