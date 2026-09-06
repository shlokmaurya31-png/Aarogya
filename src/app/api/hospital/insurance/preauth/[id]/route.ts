import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { decidePreAuth } from "@/lib/hospital/billing/preauth";

const VALID_DECISIONS = ["APPROVED", "DENIED"];

/** Manual entry of the payer's decision — no live payer API this phase. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("insurance:preauth:manage", body?.facilityId);

    const { status, approvedAmountMinor } = body ?? {};
    if (!status || !VALID_DECISIONS.includes(status)) throw new BadRequestError(`status must be one of ${VALID_DECISIONS.join(", ")}.`);

    const preAuth = await prisma.preAuthorization.findUnique({ where: { id }, include: { encounter: true } });
    if (!preAuth || preAuth.encounter.facilityId !== facilityId) throw new NotFoundError("Pre-authorization not found.");

    const updated = await prisma.$transaction((tx) => decidePreAuth(tx, id, { status, approvedAmountMinor }));

    await recordAuditEvent(
      "hospital.insurance.preauthDecided",
      session.userId,
      { preAuthId: id, status, approvedAmountMinor },
      { facilityId, patientId: preAuth.encounter.patientId, encounterId: preAuth.encounterId }
    );
    return { preAuth: updated };
  });
}
