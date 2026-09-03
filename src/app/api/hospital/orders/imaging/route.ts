import { NextRequest } from "next/server";
import type { ImagingOrderStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { createOrderEnvelope } from "@/lib/hospital/orderEnvelope";
import { mapDiagnosticPriorityToOrderPriority } from "@/lib/hospital/diagnosticsLifecycle";
import { createChargeIfNotExists } from "@/lib/hospital/billing";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status") as ImagingOrderStatus | null;

    const orders = await prisma.imagingOrder.findMany({
      where: { encounter: { facilityId }, ...(status ? { status } : {}) },
      include: {
        patient: true,
        encounter: true,
        reports: { where: { isCurrent: true } },
        studies: { orderBy: { createdAt: "desc" } },
        orderedBy: { include: { user: true } },
        catalogStudy: true,
      },
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

    const { encounterId, patientId, modality, studyDescription, priority, catalogStudyId } = body ?? {};
    if (!encounterId || !patientId || !modality || !studyDescription) throw new BadRequestError("encounterId, patientId, modality and studyDescription are required.");

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    let catalogStudy = null;
    if (catalogStudyId) {
      catalogStudy = await prisma.imagingCatalog.findUnique({ where: { id: catalogStudyId } });
      if (!catalogStudy || (catalogStudy.facilityId && catalogStudy.facilityId !== facilityId)) throw new NotFoundError("Catalog study not found.");
    }

    const order = await prisma.$transaction(async (tx) => {
      const envelope = await createOrderEnvelope(tx, {
        facilityId,
        encounterId,
        patientId,
        orderingStaffId: staff.id,
        orderType: "IMAGING",
        priority: mapDiagnosticPriorityToOrderPriority(priority),
      });
      const createdOrder = await tx.imagingOrder.create({
        data: {
          encounterId,
          patientId,
          modality,
          studyDescription,
          priority: priority ?? "ROUTINE",
          orderedByStaffId: staff.id,
          orderId: envelope.id,
          catalogStudyId: catalogStudyId ?? undefined,
        },
      });

      // First automatic charge hook for imaging (brief §18) — same idempotent
      // pattern Milestone B introduced for lab, reusing createChargeIfNotExists unchanged.
      await createChargeIfNotExists(tx, {
        encounterId,
        patientId,
        facilityId,
        description: `Imaging: ${studyDescription}`,
        category: "IMAGING",
        amount: catalogStudy?.demoPriceInr ?? 1500,
        sourceType: "ImagingOrder",
        sourceId: createdOrder.id,
      });

      // Preparation task (brief §19) — reuses the existing generic Task
      // engine via Order.orderId, mirroring lab's SPECIMEN_COLLECTION task exactly.
      await tx.task.create({
        data: {
          facilityId,
          title: `Prepare patient for ${modality}: ${studyDescription}`,
          type: "IMAGING_PREP",
          source: "imaging-order",
          patientId,
          encounterId,
          orderId: envelope.id,
          createdByStaffId: staff.id,
          priority: priority === "STAT" ? "STAT" : priority === "URGENT" ? "URGENT" : "ROUTINE",
        },
      });

      return createdOrder;
    });

    if (encounter.status === "IN_CONSULTATION" || encounter.status === "TRIAGED") {
      await prisma.encounter.update({ where: { id: encounterId }, data: { status: "INVESTIGATING" } });
    }

    await recordAuditEvent("hospital.imaging.ordered", session.userId, { orderId: order.id });
    return { order };
  });
}
