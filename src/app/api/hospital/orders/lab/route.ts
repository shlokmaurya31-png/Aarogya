import { NextRequest } from "next/server";
import type { LabOrderStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { createOrderEnvelope } from "@/lib/hospital/orderEnvelope";
import { mapDiagnosticPriorityToOrderPriority } from "@/lib/hospital/diagnosticsLifecycle";
import { accessionSpecimen } from "@/lib/hospital/specimenLifecycle";
import { createChargeIfNotExists } from "@/lib/hospital/billing";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status") as LabOrderStatus | null;

    const orders = await prisma.labOrder.findMany({
      where: { encounter: { facilityId }, ...(status ? { status } : {}) },
      include: {
        patient: true,
        encounter: true,
        results: { where: { isCurrent: true } },
        specimens: { orderBy: { createdAt: "desc" } },
        orderedBy: { include: { user: true } },
        catalogTest: true,
        panel: true,
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
    const { session, facilityId, staff } = await requireFacilityStaff("clinical:order:lab", body?.facilityId);
    if (!staff) throw new BadRequestError("Lab orders must be placed by a staff account.");

    const { encounterId, patientId, testName, category, priority, catalogTestId, panelId } = body ?? {};
    if (!encounterId || !patientId || !testName || !category) throw new BadRequestError("encounterId, patientId, testName and category are required.");

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    let catalogTest = null;
    if (catalogTestId) {
      catalogTest = await prisma.labTestCatalog.findUnique({ where: { id: catalogTestId } });
      if (!catalogTest || (catalogTest.facilityId && catalogTest.facilityId !== facilityId)) throw new NotFoundError("Catalog test not found.");
    }

    const { order, specimen } = await prisma.$transaction(async (tx) => {
      const envelope = await createOrderEnvelope(tx, {
        facilityId,
        encounterId,
        patientId,
        orderingStaffId: staff.id,
        orderType: "LAB",
        priority: mapDiagnosticPriorityToOrderPriority(priority),
      });
      const createdOrder = await tx.labOrder.create({
        data: {
          encounterId,
          patientId,
          testName,
          category,
          priority: priority ?? "ROUTINE",
          orderedByStaffId: staff.id,
          orderId: envelope.id,
          catalogTestId: catalogTestId ?? undefined,
          panelId: panelId ?? undefined,
        },
      });
      const createdSpecimen = await accessionSpecimen(tx, {
        labOrderId: createdOrder.id,
        facilityId,
        patientId,
        encounterId,
        specimenType: catalogTest?.specimenType ?? "Not specified",
      });

      // First automatic charge hook in the codebase (brief §44) — idempotent by
      // (sourceType, sourceId) since no DB-level uniqueness enforces that.
      await createChargeIfNotExists(tx, {
        encounterId,
        patientId,
        facilityId,
        description: `Lab: ${testName}`,
        category: "LAB",
        amount: catalogTest?.demoPriceInr ?? 300,
        sourceType: "LabOrder",
        sourceId: createdOrder.id,
      });

      // Nursing/collection task (brief §41) — reuses the existing generic
      // Task engine via Order.orderId, no new task table.
      await tx.task.create({
        data: {
          facilityId,
          title: `Collect specimen: ${testName}`,
          type: "SPECIMEN_COLLECTION",
          source: "lab-order",
          patientId,
          encounterId,
          orderId: envelope.id,
          createdByStaffId: staff.id,
          priority: (priority === "STAT" ? "STAT" : priority === "URGENT" ? "URGENT" : "ROUTINE"),
        },
      });

      return { order: createdOrder, specimen: createdSpecimen };
    });

    if (encounter.status === "IN_CONSULTATION" || encounter.status === "TRIAGED") {
      await prisma.encounter.update({ where: { id: encounterId }, data: { status: "INVESTIGATING" } });
    }

    await recordAuditEvent("hospital.lab.ordered", session.userId, { orderId: order.id, specimenId: specimen.id, accessionNumber: specimen.accessionNumber });
    return { order, specimen };
  });
}
