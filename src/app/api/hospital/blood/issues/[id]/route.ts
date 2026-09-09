import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { dispatchIssue, receiveIssue, returnUnit } from "@/lib/hospital/blood";

/** Transport/receipt/return actions on an issued unit. `action`: dispatch | receive | return. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const action = body?.action as string | undefined;
    const { session, facilityId, staff } = await requireFacilityStaff("blood:transport:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Transport actions require a staff account.");
    if (action === "dispatch") return { issue: await dispatchIssue({ issueId: id, facilityId, dispatchedByStaffId: staff.id, byUserId: session.userId }) };
    if (action === "receive") return { issue: await receiveIssue({ issueId: id, facilityId, receivedByStaffId: staff.id, byUserId: session.userId }) };
    if (action === "return") {
      if (!body?.reason) throw new BadRequestError("reason is required to return a unit.");
      return { issue: await returnUnit({ issueId: id, facilityId, reason: body.reason, receivedByStaffId: staff.id, byUserId: session.userId }) };
    }
    throw new BadRequestError(`Unknown action: ${action}`);
  });
}
