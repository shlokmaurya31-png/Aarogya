import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { dispositionEncounter } from "@/lib/hospital/emergency";
import type { EdDispositionType } from "@prisma/client";

const VALID_TYPES: EdDispositionType[] = ["DISCHARGE", "ADMIT_WARD", "ADMIT_ICU", "TO_OT", "TRANSFER_OUT", "REFERRAL", "LAMA", "DAMA", "LWBS", "ABSCONDED", "DECEASED"];

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const type = body?.type as EdDispositionType | undefined;
    if (!type || !VALID_TYPES.includes(type)) throw new BadRequestError("A valid disposition type is required.");
    // Recording a death is further restricted beyond ordinary disposition (brief §19).
    const permission = type === "DECEASED" ? "ed:disposition:death" : "ed:disposition:manage";
    const { session, facilityId, staff } = await requireFacilityStaff(permission, body?.facilityId);
    if (!staff) throw new BadRequestError("Disposition requires a staff account.");
    const disposition = await dispositionEncounter({
      encounterId: id, facilityId, type, dispositionedByStaffId: staff.id, bedId: body?.bedId, admissionReason: body?.admissionReason,
      admissionType: body?.admissionType, destinationDetail: body?.destinationDetail, transferFacilityName: body?.transferFacilityName,
      reason: body?.reason, note: body?.note, lastKnownLocation: body?.lastKnownLocation, byUserId: session.userId,
    });
    return { disposition };
  });
}
