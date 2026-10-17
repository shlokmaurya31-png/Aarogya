import { NextRequest } from "next/server";
import { respondToReferral } from "@/lib/hospital/referral";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";


/**
 * Specialist consult workflow (brief §8/§161): requested -> accepted ->
 * reviewed/documented -> closed, tracked as one referral row's status.
 * ACKNOWLEDGED is this system's "accepted" (Phase 1 vocabulary, unchanged) —
 * Phase 3 additionally stamps `acceptedAt` the first time that happens, and
 * `respondedAt` continues to mean "last terminal-or-response timestamp".
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("referral:respond", body?.facilityId);

    const { status, notes } = body ?? {};
    const { referral: updated, previous: referral } = await respondToReferral({ referralId: id, facilityId, status, notes, staffId: staff?.id, byUserId: session.userId });

    await recordAuditEvent(
      "hospital.referral.updated",
      session.userId,
      { referralId: id, status },
      { facilityId, patientId: referral.patientId, encounterId: referral.encounterId }
    );
    if (status === "ACKNOWLEDGED")
      await recordAuditEvent(
        "hospital.consult.accepted",
        session.userId,
        { referralId: id },
        { facilityId, patientId: referral.patientId, encounterId: referral.encounterId }
      );
    if (status === "COMPLETED")
      await recordAuditEvent(
        "hospital.consult.completed",
        session.userId,
        { referralId: id },
        { facilityId, patientId: referral.patientId, encounterId: referral.encounterId }
      );
    return { referral: updated };
  });
}
