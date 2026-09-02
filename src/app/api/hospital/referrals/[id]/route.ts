import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

const VALID_STATUSES = ["ACKNOWLEDGED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "REJECTED"];

/** Care coordination (brief §161): consult requested -> accepted -> performed, tracked as one referral row's status. */
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
      },
    });

    await recordAuditEvent("hospital.referral.updated", session.userId, { referralId: id, status });
    return { referral: updated };
  });
}
