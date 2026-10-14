import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { requestConsent, grantConsent, listConsents } from "@/lib/consent";

/**
 * Staff-recorded consents (e.g. a treatment consent signed at the desk), in the
 * single consent model through the consent service (D2). The recipient is the
 * facility itself; `scope` (free text) is kept as the consent's description,
 * and `scopes` are the structured data scopes (default ALL_CLINICAL).
 */
const LEGACY_PURPOSES: Record<string, string> = { PROCEDURE: "TREATMENT", DATA_SHARING: "OTHER" };

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const patientId = searchParams.get("patientId");
    if (!patientId) throw new BadRequestError("patientId is required.");

    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");
    return { consents: await listConsents({ facilityId, patientId }) };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("consent:manage", body?.facilityId);

    const { patientId, purpose, scope, scopes, status, expiresAt } = body ?? {};
    if (!patientId || !purpose) throw new BadRequestError("patientId and purpose are required.");
    if (status && status !== "GRANTED" && status !== "REQUESTED") throw new BadRequestError("status must be GRANTED or REQUESTED.");

    const facility = await prisma.facility.findUniqueOrThrow({ where: { id: facilityId }, select: { name: true } });
    const requested = await requestConsent({
      facilityId,
      patientId,
      purpose: LEGACY_PURPOSES[purpose] ?? purpose,
      scopes: Array.isArray(scopes) && scopes.length ? scopes : ["ALL_CLINICAL"],
      recipientType: "FACILITY",
      recipientIdentifier: facilityId,
      recipientName: facility.name,
      description: typeof scope === "string" ? scope : undefined,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      createdByStaffId: staff?.id,
      byUserId: session.userId,
    });
    const consent = (status ?? "GRANTED") === "GRANTED"
      ? await grantConsent({ facilityId, consentId: requested.id, grantedBy: "STAFF_RECORDED", byUserId: session.userId })
      : requested;

    await recordAuditEvent(
      "hospital.consent.recorded",
      session.userId,
      { consentId: consent.id, patientId, purpose: consent.purpose, status: consent.status },
      { facilityId, patientId }
    );
    return { consent };
  });
}
