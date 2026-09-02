import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

const VALID_STATUSES = ["ACKNOWLEDGED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "REJECTED"];

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

    const referral = await prisma.referral.findUnique({ where: { id }, include: { encounter: true } });
    if (!referral || referral.encounter.facilityId !== facilityId) throw new NotFoundError("Referral not found.");

    const { status, notes } = body ?? {};
    if (!status || !VALID_STATUSES.includes(status)) throw new BadRequestError(`status must be one of ${VALID_STATUSES.join(", ")}.`);

    const updated = await prisma.referral.update({
      where: { id },
      data: {
        status,
        notes: notes ?? referral.notes,
        toStaffId: referral.toStaffId ?? staff?.id,
        respondedAt: new Date(),
        acceptedAt: status === "ACKNOWLEDGED" && !referral.acceptedAt ? new Date() : referral.acceptedAt,
      },
    });

    await recordAuditEvent("hospital.referral.updated", session.userId, { referralId: id, status });
    if (status === "ACKNOWLEDGED") await recordAuditEvent("hospital.consult.accepted", session.userId, { referralId: id });
    if (status === "COMPLETED") await recordAuditEvent("hospital.consult.completed", session.userId, { referralId: id });
    return { referral: updated };
  });
}
