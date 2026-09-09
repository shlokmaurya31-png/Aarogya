import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { getPatientMedicationTrace } from "@/lib/hospital/pharmacy";

export async function GET(req: NextRequest, { params }: { params: Promise<{ patientId: string }> }) {
  return withApiErrors(async () => {
    const { patientId } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("pharmacy:trace:view", searchParams.get("facilityId") ?? undefined);
    return { trace: await getPatientMedicationTrace(patientId, facilityId) };
  });
}
