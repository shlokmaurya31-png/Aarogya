import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

/**
 * Consent as a non-boolean, versioned record (brief §27). Not yet wired to
 * gate any workflow this phase — see docs/CLINICAL_CORE.md §9.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const patientId = searchParams.get("patientId");
    if (!patientId) throw new BadRequestError("patientId is required.");

    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const consents = await prisma.consent.findMany({ where: { patientId }, orderBy: { createdAt: "desc" } });
    return { consents };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("consent:manage", body?.facilityId);

    const { patientId, purpose, scope, status, expiresAt } = body ?? {};
    if (!patientId || !purpose) throw new BadRequestError("patientId and purpose are required.");

    const patient = await prisma.patient.findUnique({ where: { id: patientId } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const resolvedStatus = status ?? "GRANTED";
    const consent = await prisma.consent.create({
      data: {
        patientId,
        purpose,
        scope,
        status: resolvedStatus,
        grantedAt: resolvedStatus === "GRANTED" ? new Date() : undefined,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        actorStaffId: staff?.id,
      },
    });

    await recordAuditEvent("hospital.consent.recorded", session.userId, { consentId: consent.id, patientId, purpose, status: resolvedStatus });
    return { consent };
  });
}
