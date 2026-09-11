import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requestConsent, listConsents } from "@/lib/hospital/interoperability/consent";

/** Phase C1 — health information exchange consent. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("interop:consent:read", searchParams.get("facilityId") ?? undefined);
    const consents = await listConsents({
      facilityId,
      patientId: searchParams.get("patientId") ?? undefined,
      status: searchParams.get("status") ?? undefined,
    });
    return { consents };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("interop:consent:manage", body?.facilityId);
    if (!body?.patientId || !body?.purpose || !body?.recipientType || !body?.recipientIdentifier) {
      throw new BadRequestError("patientId, purpose, recipientType and recipientIdentifier are required.");
    }
    if (!Array.isArray(body?.scopes) || body.scopes.length === 0) {
      throw new BadRequestError("At least one data scope is required.");
    }
    const consent = await requestConsent({
      facilityId,
      patientId: body.patientId,
      purpose: body.purpose,
      scopes: body.scopes,
      recipientType: body.recipientType,
      recipientIdentifier: body.recipientIdentifier,
      recipientSystem: body.recipientSystem,
      recipientName: body.recipientName,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      externalConsentRef: body.externalConsentRef,
      createdByStaffId: staff?.id,
      byUserId: session.userId,
    });
    return { consent };
  });
}
