import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

/** Revocation (brief §27's REVOKED status) — a consent is never deleted, only transitioned. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("consent:manage", body?.facilityId);

    const consent = await prisma.consent.findUnique({ where: { id }, include: { patient: true } });
    if (!consent || consent.patient.facilityId !== facilityId) throw new NotFoundError("Consent not found.");

    const updated = await prisma.consent.update({
      where: { id },
      data: { status: "REVOKED", revokedAt: new Date() },
    });

    await recordAuditEvent("hospital.consent.revoked", session.userId, { consentId: id });
    return { consent: updated };
  });
}
