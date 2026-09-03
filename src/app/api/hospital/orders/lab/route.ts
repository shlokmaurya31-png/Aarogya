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

const VALID_ORDER_PRIORITIES = ["ROUTINE", "URGENT", "STAT"];

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
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
    if (typeof testName !== "string" || testName.length > 500) throw new BadRequestError("testName must be a string of at most 500 characters.");
    if (typeof category !== "string" || category.length > 200) throw new BadRequestError("category must be a string of at most 200 characters.");
    if (priority !== undefined && priority !== null && !VALID_ORDER_PRIORITIES.includes(priority)) {
      throw new BadRequestError(`priority must be one of ${VALID_ORDER_PRIORITIES.join(", ")}.`);
    }

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");
    // Milestone E hardening — patientId was previously trusted verbatim from
    // the client with no cross-check against the encounter it's supposedly
    // for; a mismatched pair created a LabOrder/Specimen filed under one
    // patient's encounter but attributed to a different patientId, which
    // src/lib/patient/timeline.ts and summary.ts (which read by patientId,
    // not by encounter ownership) would then surface as wrong-patient PHI.
    if (encounter.patientId !== patientId) throw new BadRequestError("patientId does not match the encounter's patient.");

    let catalogTest = null;
    if (catalogTestId) {
      catalogTest = await prisma.labTestCatalog.findUnique({ where: { id: catalogTestId } });
      if (!catalogTest || (catalogTest.facilityId && catalogTest.facilityId !== facilityId)) throw new NotFoundError("Catalog test not found.");
    }

    const { order, specimen, duplicate, charge, task } = await prisma.$transaction(async (tx) => {
      // Milestone E hardening — createChargeIfNotExists's idempotency check
      // compares against sourceId: createdOrder.id, an ID generated fresh
      // by THIS request, so it could never catch an actual duplicate
      // submission (double-click, client retry after a timeout). This
      // dedupe window catches the realistic case (an honest resubmit of the
      // exact same order within seconds) and returns the existing order
      // instead of erroring, so a network retry is harmless.
      const recentDuplicate = await tx.labOrder.findFirst({
        where: {
          encounterId,
          testName,
          orderedByStaffId: staff.id,
          orderedAt: { gte: new Date(Date.now() - 15_000) },
        },
        include: { encounter: true, patient: true },
        orderBy: { orderedAt: "desc" },
      });
      if (recentDuplicate) {
        const existingSpecimen = await tx.specimen.findFirst({ where: { labOrderId: recentDuplicate.id }, orderBy: { createdAt: "desc" } });
        return { order: recentDuplicate, specimen: existingSpecimen, duplicate: true as const, charge: null, task: null };
      }

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
      // (sourceType, sourceId), now also backed by a DB-level unique
      // constraint (Milestone E hardening, see prisma/migrations).
      const chargeResult = await createChargeIfNotExists(tx, {
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
      const task = await tx.task.create({
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

      return { order: createdOrder, specimen: createdSpecimen, duplicate: false as const, charge: chargeResult.charge, task };
    });

    if (!duplicate && (encounter.status === "IN_CONSULTATION" || encounter.status === "TRIAGED")) {
      await prisma.encounter.update({ where: { id: encounterId }, data: { status: "INVESTIGATING" } });
    }

    if (duplicate) {
      // A genuine retry/double-click of the same order — the client gets
      // the original order back, no new audit noise, no duplicate charge/task.
      return { order, specimen };
    }

    await recordAuditEvent("hospital.lab.ordered", session.userId, { orderId: order.id, specimenId: specimen?.id, accessionNumber: specimen?.accessionNumber });
    // Milestone E hardening — closes an audit-coverage gap: automatic task
    // and charge creation previously left no dedicated audit trace (only
    // discoverable indirectly via hospital.lab.ordered's detail, which
    // didn't even include the task/charge IDs).
    if (task) await recordAuditEvent("hospital.task.created", session.userId, { taskId: task.id, type: "SPECIMEN_COLLECTION", orderId: order.id });
    if (charge) await recordAuditEvent("hospital.billing.chargeCreated", session.userId, { chargeId: charge.id, amount: charge.amount, sourceType: "LabOrder", sourceId: order.id });
    return { order, specimen };
  });
}
