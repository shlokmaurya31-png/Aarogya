import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { decideLinkRequest } from "@/lib/patient/selfRegistration";

/** Body: { decision: "LINK" | "CREATE_NEW" | "REJECT", note? }. Audited. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("patient:duplicate:review", body?.facilityId);
    const decision = body?.decision;
    if (decision !== "LINK" && decision !== "CREATE_NEW" && decision !== "REJECT") throw new BadRequestError("decision must be LINK, CREATE_NEW or REJECT.");
    return decideLinkRequest({ facilityId, requestId: id, decision, reviewerUserId: session.userId, note: typeof body?.note === "string" ? body.note.slice(0, 500) : undefined });
  });
}
