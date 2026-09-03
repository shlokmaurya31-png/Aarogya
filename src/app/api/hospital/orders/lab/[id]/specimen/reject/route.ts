import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { rejectSpecimen } from "@/lib/hospital/specimenLifecycle";

const VALID_REASONS = ["INSUFFICIENT_SPECIMEN", "WRONG_CONTAINER", "HEMOLYZED", "MISLABELED", "LEAKED", "EXPIRED_TRANSPORT", "INCORRECT_SPECIMEN_TYPE", "OTHER"];

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("lab:specimen:reject", body?.facilityId);
    if (!staff) throw new NotFoundError("Staff account required.");

    const order = await prisma.labOrder.findUnique({ where: { id }, include: { encounter: true } });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Lab order not found.");

    const { reason, notes } = body ?? {};
    if (!reason || !VALID_REASONS.includes(reason)) throw new BadRequestError(`reason must be one of: ${VALID_REASONS.join(", ")}`);

    const specimen = await prisma.specimen.findFirst({ where: { labOrderId: id, status: { in: ["COLLECTED", "RECEIVED"] } }, orderBy: { createdAt: "desc" } });
    if (!specimen) throw new NotFoundError("No collected/received specimen eligible for rejection on this order.");

    const updated = await prisma.$transaction((tx) => rejectSpecimen(tx, specimen.id, reason, staff.id, notes));

    await recordAuditEvent("hospital.lab.specimenRejected", session.userId, { labOrderId: id, specimenId: specimen.id, reason });
    return { specimen: updated };
  });
}
