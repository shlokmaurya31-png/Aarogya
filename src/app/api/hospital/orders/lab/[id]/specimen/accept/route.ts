import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { acceptSpecimen } from "@/lib/hospital/specimenLifecycle";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("lab:specimen:accept", body?.facilityId);
    if (!staff) throw new NotFoundError("Staff account required.");

    const order = await prisma.labOrder.findUnique({ where: { id }, include: { encounter: true } });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Lab order not found.");

    const specimen = await prisma.specimen.findFirst({ where: { labOrderId: id, status: "RECEIVED" }, orderBy: { createdAt: "desc" } });
    if (!specimen) throw new NotFoundError("No received specimen awaiting acceptance for this order.");

    const updated = await prisma.$transaction((tx) => acceptSpecimen(tx, specimen.id, staff.id));

    await recordAuditEvent("hospital.lab.specimenAccepted", session.userId, { labOrderId: id, specimenId: specimen.id });
    return { specimen: updated };
  });
}
