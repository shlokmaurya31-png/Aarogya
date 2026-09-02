import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

/** Lab result release (brief §27) — a critical result generates the acknowledgement workflow surfaced by the alert engine, it does not resolve itself. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("lab:result:enter", body?.facilityId);

    const order = await prisma.labOrder.findUnique({ where: { id }, include: { encounter: true } });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Lab order not found.");

    const { value, unit, referenceRange, isCritical } = body ?? {};
    if (!value) throw new BadRequestError("value is required.");

    const result = await prisma.$transaction(async (tx) => {
      const created = await tx.labResult.create({
        data: { labOrderId: id, value, unit, referenceRange, isCritical: Boolean(isCritical), releasedByStaffId: staff?.id },
      });
      await tx.labOrder.update({ where: { id }, data: { status: "RESULTED" } });
      return created;
    });

    await recordAuditEvent("hospital.lab.resultReleased", session.userId, { labOrderId: id, isCritical: Boolean(isCritical) });
    return { result };
  });
}
