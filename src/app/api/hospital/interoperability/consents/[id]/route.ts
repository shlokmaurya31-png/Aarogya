import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { getConsent, grantConsent, revokeConsent, closeConsentRequest } from "@/lib/hospital/interoperability/consent";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("interop:consent:read", searchParams.get("facilityId") ?? undefined);
    const consent = await getConsent(facilityId, id);
    return { consent };
  });
}

/**
 * Consent lifecycle. Grant and revoke are separately permissioned from ordinary
 * consent management, so recording a consent request and actually granting it
 * are different authorities.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const action = body?.action;

    if (action === "grant") {
      const { session, facilityId } = await requireFacilityStaff("interop:consent:grant", body?.facilityId);
      const consent = await grantConsent({
        facilityId, consentId: id,
        grantedBy: body?.grantedBy ?? "STAFF_RECORDED",
        expiresAt: body?.expiresAt ? new Date(body.expiresAt) : undefined,
        externalConsentRef: body?.externalConsentRef,
        byUserId: session.userId,
      });
      return { consent };
    }

    if (action === "revoke") {
      const { session, facilityId, staff } = await requireFacilityStaff("interop:consent:revoke", body?.facilityId);
      const consent = await revokeConsent({
        facilityId, consentId: id, reason: body?.reason,
        revokedByStaffId: staff?.id, byUserId: session.userId,
      });
      return { consent };
    }

    if (action === "decline" || action === "cancel") {
      const { session, facilityId } = await requireFacilityStaff("interop:consent:manage", body?.facilityId);
      const consent = await closeConsentRequest({
        facilityId, consentId: id,
        to: action === "decline" ? "DECLINED" : "CANCELLED",
        byUserId: session.userId,
      });
      return { consent };
    }

    throw new BadRequestError("action must be grant, revoke, decline or cancel.");
  });
}
