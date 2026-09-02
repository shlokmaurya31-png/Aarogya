import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");

    const orders = await prisma.imagingOrder.findMany({
      where: { encounter: { facilityId }, ...(status ? { status } : {}) },
      include: { patient: true, encounter: true, report: true, orderedBy: { include: { user: true } } },
      orderBy: { orderedAt: "desc" },
      take: 100,
    });
    return { orders };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("clinical:order:imaging", body?.facilityId);
    if (!staff) throw new BadRequestError("Imaging orders must be placed by a staff account.");

    const { encounterId, patientId, modality, studyDescription, priority } = body ?? {};
    if (!encounterId || !patientId || !modality || !studyDescription) throw new BadRequestError("encounterId, patientId, modality and studyDescription are required.");

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const order = await prisma.imagingOrder.create({
      data: { encounterId, patientId, modality, studyDescription, priority: priority ?? "ROUTINE", orderedByStaffId: staff.id },
    });

    if (encounter.status === "IN_CONSULTATION" || encounter.status === "TRIAGED") {
      await prisma.encounter.update({ where: { id: encounterId }, data: { status: "INVESTIGATING" } });
    }

    await recordAuditEvent("hospital.imaging.ordered", session.userId, { orderId: order.id });
    return { order };
  });
}
