import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordTransfusionObservation, transitionTransfusion, reportReaction } from "@/lib/hospital/blood";

/** Bedside transfusion actions. `action`: observation | status | reaction. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const action = body?.action as string | undefined;

    if (action === "reaction") {
      const { session, facilityId, staff } = await requireFacilityStaff("blood:reaction:record", body?.facilityId);
      if (!staff) throw new BadRequestError("Reaction reporting requires a staff account.");
      const reaction = await reportReaction({ transfusionId: id, facilityId, reportedByStaffId: staff.id, symptoms: body?.symptoms, actionTaken: body?.actionTaken, notes: body?.notes, byUserId: session.userId });
      return { reaction };
    }

    const { session, facilityId, staff } = await requireFacilityStaff("blood:transfusion:record", body?.facilityId);
    if (!staff) throw new BadRequestError("Transfusion recording requires a staff account.");
    if (action === "observation") {
      if (!body?.observationType || body?.value === undefined) throw new BadRequestError("observationType and value are required.");
      const observation = await recordTransfusionObservation({ transfusionId: id, facilityId, observationType: body.observationType, value: String(body.value), recordedByStaffId: staff.id, byUserId: session.userId });
      return { observation };
    }
    if (action === "status") {
      if (!body?.to) throw new BadRequestError("to (target status) is required.");
      const transfusion = await transitionTransfusion({ transfusionId: id, facilityId, to: body.to, reason: body.reason, byUserId: session.userId });
      return { transfusion };
    }
    throw new BadRequestError(`Unknown action: ${action}`);
  });
}
