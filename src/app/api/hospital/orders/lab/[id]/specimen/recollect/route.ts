import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { recollectSpecimen } from "@/lib/hospital/specimenLifecycle";

/** Creates a NEW specimen linked to the rejected original — the original row is never edited (brief §15). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("lab:specimen:collect", body?.facilityId);
    if (!staff) throw new NotFoundError("Staff account required.");

    const order = await prisma.labOrder.findUnique({ where: { id }, include: { encounter: true } });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Lab order not found.");

    const rejected = await prisma.specimen.findFirst({ where: { labOrderId: id, status: "REJECTED" }, orderBy: { createdAt: "desc" } });
    if (!rejected) throw new NotFoundError("No rejected specimen awaiting recollection for this order.");

    const created = await prisma.$transaction((tx) => recollectSpecimen(tx, rejected.id, body?.specimenType));

    await recordAuditEvent("hospital.lab.specimenRecollected", session.userId, { labOrderId: id, originalSpecimenId: rejected.id, newSpecimenId: created.id, accessionNumber: created.accessionNumber });
    return { specimen: created };
  });
}
