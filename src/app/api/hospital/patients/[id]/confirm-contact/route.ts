import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { confirmPatientContact } from "@/lib/person/linking";

/** Phase 0: staff confirm the phone on the record with the patient present (it can then receive a link code for 12 months). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("patient:checkin", body?.facilityId);
    return confirmPatientContact({ facilityId, patientId: id, byUserId: session.userId });
  });
}
