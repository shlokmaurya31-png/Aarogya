import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { classifyMedicationReturn } from "@/lib/hospital/pharmacy";
import type { MedicationReturnClassification } from "@prisma/client";

const VALID: MedicationReturnClassification[] = ["RETURN_TO_STOCK", "QUARANTINE", "WASTAGE"];

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("pharmacy:return", body?.facilityId);
    if (!staff) throw new BadRequestError("Return classification requires a staff account.");
    if (!body?.classification || !VALID.includes(body.classification)) throw new BadRequestError("A valid classification is required.");
    const ret = await classifyMedicationReturn({ returnId: id, facilityId, classification: body.classification, inspectedByStaffId: staff.id, wasteReason: body.wasteReason, byUserId: session.userId });
    return { return: ret };
  });
}
