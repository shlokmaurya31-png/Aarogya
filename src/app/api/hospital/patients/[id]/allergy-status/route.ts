import { NextRequest } from "next/server";
import { allergyStatusHistory, recordAllergyStatus } from "@/lib/hospital/clinicalRecords";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

/**
 * Week 4b (4a follow-up b): the record's allergy status (NO_KNOWN_ALLERGIES |
 * UNKNOWN | HAS_ALLERGIES) and its history. No entry reads as UNKNOWN, which
 * the prescribing check (src/lib/hospital/clinicalSafety.ts) flags.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    return allergyStatusHistory(id, facilityId);
  });
}

/** { status: "NO_KNOWN_ALLERGIES" | "UNKNOWN" | "HAS_ALLERGIES" } */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("allergy:manage", body?.facilityId);
    const result = await recordAllergyStatus({ patientId: id, facilityId, status: body?.status, byUserId: session.userId });
    if (result.changed) await recordAuditEvent("hospital.allergy_status.recorded", session.userId, { patientId: id, status: result.status.status }, { facilityId, patientId: id });
    return result;
  });
}
