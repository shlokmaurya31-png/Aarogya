import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { revokeConsent } from "@/lib/consent";

/** Revocation — a consent is never deleted, only transitioned (via the consent service). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("consent:manage", body?.facilityId);
    const consent = await revokeConsent({
      facilityId, consentId: id, reason: typeof body?.reason === "string" ? body.reason : undefined,
      revokedByStaffId: staff?.id, byUserId: session.userId,
    });
    await recordAuditEvent("hospital.consent.revoked", session.userId, { consentId: id }, { facilityId, patientId: consent.patientId });
    return { consent };
  });
}
