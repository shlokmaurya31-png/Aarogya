import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAnesthesia } from "@/lib/hospital/surgery";
import type { AnesthesiaType } from "@prisma/client";

const TYPES = ["GENERAL", "REGIONAL", "LOCAL", "SEDATION", "OTHER"];

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("ot:anesthesia:record", body?.facilityId);
    if (!staff) throw new BadRequestError("Must be performed by a staff account.");
    if (!body?.type || !TYPES.includes(body.type)) throw new BadRequestError(`type must be one of ${TYPES.join(", ")}.`);
    const record = await recordAnesthesia({
      surgeryId: id, facilityId, type: body.type as AnesthesiaType, anesthetistStaffId: body.anesthetistStaffId ?? staff.id,
      status: body.status, startAt: body.startAt ? new Date(body.startAt) : undefined, endAt: body.endAt ? new Date(body.endAt) : undefined,
      intraOpNotes: body.intraOpNotes, complications: body.complications, byUserId: session.userId,
    });
    return { record };
  });
}
