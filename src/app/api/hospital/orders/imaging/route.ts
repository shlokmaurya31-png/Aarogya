import { NextRequest } from "next/server";
import type { ImagingOrderStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { createOrderEnvelope } from "@/lib/hospital/orderEnvelope";
import { mapDiagnosticPriorityToOrderPriority } from "@/lib/hospital/diagnosticsLifecycle";
import { createChargeIfNotExists } from "@/lib/hospital/billing";

const VALID_ORDER_PRIORITIES = ["ROUTINE", "URGENT", "STAT"];

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
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
    if (typeof studyDescription !== "string" || studyDescription.length > 500) throw new BadRequestError("studyDescription must be a string of at most 500 characters.");
    if (typeof modality !== "string" || modality.length > 100) throw new BadRequestError("modality must be a string of at most 100 characters.");
    if (priority !== undefined && priority !== null && !VALID_ORDER_PRIORITIES.includes(priority)) {
      throw new BadRequestError(`priority must be one of ${VALID_ORDER_PRIORITIES.join(", ")}.`);
    }

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");
    // Milestone E hardening — see the identical check + rationale in
    // orders/lab/route.ts.
    if (encounter.patientId !== patientId) throw new BadRequestError("patientId does not match the encounter's patient.");

    let catalogStudy = null;
    if (catalogStudyId) {
      catalogStudy = await prisma.imagingCatalog.findUnique({ where: { id: catalogStudyId } });
      if (!catalogStudy || (catalogStudy.facilityId && catalogStudy.facilityId !== facilityId)) throw new NotFoundError("Catalog study not found.");
    }

    const { order, duplicate, charge, task } = await prisma.$transaction(async (tx) => {
      // Milestone E hardening — see the identical dedupe rationale in
      // orders/lab/route.ts.
      const recentDuplicate = await tx.imagingOrder.findFirst({
        where: {
          encounterId,
          studyDescription,
          orderedByStaffId: staff.id,
          orderedAt: { gte: new Date(Date.now() - 15_000) },
        },
        orderBy: { orderedAt: "desc" },
      });
      if (recentDuplicate) {
        return { order: recentDuplicate, duplicate: true as const, charge: null, task: null };
      }

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
      // pattern Milestone B introduced for lab, reusing createChargeIfNotExists,
      // now also backed by a DB-level unique constraint (Milestone E hardening).
      const chargeResult = await createChargeIfNotExists(tx, {
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
      const createdTask = await tx.task.create({
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

      return { order: createdOrder, duplicate: false as const, charge: chargeResult.charge, task: createdTask };
    });

    if (!duplicate && (encounter.status === "IN_CONSULTATION" || encounter.status === "TRIAGED")) {
      await prisma.encounter.update({ where: { id: encounterId }, data: { status: "INVESTIGATING" } });
    }

    if (duplicate) {
      return { order };
    }

    await recordAuditEvent("hospital.imaging.ordered", session.userId, { orderId: order.id });
    // Milestone E hardening — audit-coverage gap (see orders/lab/route.ts).
    if (task) await recordAuditEvent("hospital.task.created", session.userId, { taskId: task.id, type: "IMAGING_PREP", orderId: order.id });
    if (charge) await recordAuditEvent("hospital.billing.chargeCreated", session.userId, { chargeId: charge.id, amount: charge.amount, sourceType: "ImagingOrder", sourceId: order.id });
    return { order };
  });
}
