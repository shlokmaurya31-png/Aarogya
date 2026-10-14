import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { addDiagnosisToProblemList } from "@/lib/hospital/problemList";

/** "Add to problem list" for an encounter diagnosis (D3). Idempotent. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("problem:manage", body?.facilityId);
    return addDiagnosisToProblemList({ facilityId, diagnosisId: id, byUserId: session.userId });
  });
}
