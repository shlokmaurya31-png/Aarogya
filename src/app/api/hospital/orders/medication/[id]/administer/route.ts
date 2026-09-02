import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

/** Medication Administration Record entry (brief §21) — nurse marks a scheduled dose given/held. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("medication:administer", body?.facilityId);

    const order = await prisma.medicationOrder.findUnique({ where: { id }, include: { encounter: true } });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Medication order not found.");

    const status = body?.status === "HELD" ? "HELD" : "GIVEN";
    const administrationId = body?.administrationId as string | undefined;
    if (!administrationId) throw new BadRequestError("administrationId is required.");

    const updated = await prisma.medicationAdministration.update({
      where: { id: administrationId },
      data: { status, administeredAt: new Date(), administeredByStaffId: staff?.id, notes: body?.notes },
    });

    await recordAuditEvent("hospital.medication.administered", session.userId, { orderId: id, administrationId, status });
    return { administration: updated };
  });
}
