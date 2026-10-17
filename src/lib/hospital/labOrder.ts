import { $Enums, type Prisma } from "@prisma/client";
import { createTask } from "@/lib/hospital/task";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { parseOptionalEnum } from "@/lib/enumValue";
import { createOrderEnvelope, syncOrderStatus } from "./orderEnvelope";
import { mapDiagnosticPriorityToOrderPriority } from "./diagnosticsLifecycle";
import { accessionSpecimen } from "./specimenLifecycle";
import { createPricedChargeIfNotExists } from "./billing/chargeCapture";
import { PriceNotFoundError } from "./billing/pricing";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

type Tx = Prisma.TransactionClient;

/** Moves the encounter to INVESTIGATING if it was in consultation or triaged (compare-and-set, in the order's transaction). */
export async function markEncounterInvestigating(tx: Tx, encounterId: string) {
  await tx.encounter.updateMany({ where: { id: encounterId, status: { in: ["IN_CONSULTATION", "TRIAGED"] } }, data: { status: "INVESTIGATING" } });
}

/**
 * Place a lab order (POST /api/hospital/orders/lab), in one transaction:
 * Order envelope + LabOrder + specimen accession + the priced charge (§5.2:
 * lab charges stay in-transaction) + the collection task, and the encounter
 * moves to INVESTIGATING, and LabOrderPlaced is emitted. A resubmission of
 * the same test by the same staff member within 15 s returns the existing
 * order (double-click / client retry) and emits nothing.
 */
export async function placeLabOrder(input: {
  facilityId: string;
  staffId: string;
  byUserId: string;
  encounterId: unknown;
  patientId: unknown;
  testName: unknown;
  category: unknown;
  priority?: unknown;
  catalogTestId?: unknown;
  panelId?: unknown;
}) {
  const { facilityId, staffId } = input;
  const { encounterId, patientId, testName, category } = input;
  if (!encounterId || !patientId || !testName || !category) throw new BadRequestError("encounterId, patientId, testName and category are required.");
  if (typeof encounterId !== "string" || typeof patientId !== "string") throw new BadRequestError("encounterId and patientId must be strings.");
  if (typeof testName !== "string" || testName.length > 500) throw new BadRequestError("testName must be a string of at most 500 characters.");
  if (typeof category !== "string" || category.length > 200) throw new BadRequestError("category must be a string of at most 200 characters.");
  const priority = parseOptionalEnum($Enums.Priority, input.priority, "priority");
  const catalogTestId = typeof input.catalogTestId === "string" ? input.catalogTestId : undefined;
  const panelId = typeof input.panelId === "string" ? input.panelId : undefined;

  const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
  if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");
  // The patient must be the encounter's: a mismatched pair would file the
  // order under one patient's encounter but attribute it to another patient.
  if (encounter.patientId !== patientId) throw new BadRequestError("patientId does not match the encounter's patient.");

  let catalogTest = null;
  if (catalogTestId) {
    catalogTest = await prisma.labTestCatalog.findUnique({ where: { id: catalogTestId } });
    if (!catalogTest || (catalogTest.facilityId && catalogTest.facilityId !== facilityId)) throw new NotFoundError("Catalog test not found.");
  }

  const result = await prisma.$transaction(async (tx) => {
    const recentDuplicate = await tx.labOrder.findFirst({
      where: { encounterId, testName, orderedByStaffId: staffId, orderedAt: { gte: new Date(Date.now() - 15_000) } },
      include: { encounter: true, patient: true },
      orderBy: { orderedAt: "desc" },
    });
    if (recentDuplicate) {
      const existingSpecimen = await tx.specimen.findFirst({ where: { labOrderId: recentDuplicate.id }, orderBy: { createdAt: "desc" } });
      return { order: recentDuplicate, specimen: existingSpecimen, duplicate: true as const, charge: null, task: null };
    }

    const envelope = await createOrderEnvelope(tx, {
      facilityId, encounterId, patientId, orderingStaffId: staffId, orderType: "LAB",
      priority: mapDiagnosticPriorityToOrderPriority(priority),
    });
    const order = await tx.labOrder.create({
      data: {
        encounterId, patientId, testName, category, priority: priority ?? "ROUTINE",
        orderedByStaffId: staffId, orderId: envelope.id, catalogTestId, panelId,
      },
    });
    await syncOrderStatus(tx, "LAB", order.id);
    const specimen = await accessionSpecimen(tx, {
      labOrderId: order.id, facilityId, patientId, encounterId, specimenType: catalogTest?.specimenType ?? "Not specified",
    });

    // Priced server-side: catalogue code, else a per-test tariff, else the
    // generic LAB tariff. Idempotent on (LabOrder, order.id).
    const chargeBase = { encounterId, patientId, facilityId, category: "LAB", sourceType: "LabOrder", sourceId: order.id, postedByUserId: staffId };
    let charged;
    try {
      charged = await createPricedChargeIfNotExists(tx, { ...chargeBase, description: `Lab: ${testName}`, chargeCode: catalogTest?.code ?? `LAB:${testName.trim().toUpperCase()}` });
    } catch (err) {
      if (!(err instanceof PriceNotFoundError)) throw err;
      charged = await createPricedChargeIfNotExists(tx, { ...chargeBase, description: `Lab: ${testName} (generic tariff)`, chargeCode: "LAB:GENERIC" });
    }

    const task = await createTask(tx, {
      facilityId, title: `Collect specimen: ${testName}`, type: "SPECIMEN_COLLECTION", source: "ORDER",
      patientId, encounterId, orderId: envelope.id, createdByStaffId: staffId, priority: priority ?? "ROUTINE",
    }, input.byUserId);
    await markEncounterInvestigating(tx, encounterId);
    await emitFacilityEvent(tx, {
      type: "LabOrderPlaced", aggregateId: order.id, facilityId, actorUserId: input.byUserId, encounterId,
      payload: { labOrderId: order.id, orderId: envelope.id, encounterId, patientId, priority: order.priority, ...(catalogTestId ? { catalogTestId } : {}) },
    });
    return { order, specimen, duplicate: false as const, charge: charged.charge, task };
  });

  if (!result.duplicate) {
    const ctx = { facilityId, patientId, encounterId };
    await recordAuditEvent("hospital.lab.ordered", input.byUserId, { orderId: result.order.id, specimenId: result.specimen?.id, accessionNumber: result.specimen?.accessionNumber }, ctx);
    await recordAuditEvent("hospital.task.created", input.byUserId, { taskId: result.task.id, type: "SPECIMEN_COLLECTION", orderId: result.order.id }, ctx);
    if (result.charge) {
      await recordAuditEvent("hospital.billing.chargeCreated", input.byUserId, { chargeId: result.charge.id, netAmountMinor: result.charge.netAmountMinor, sourceType: "LabOrder", sourceId: result.order.id }, ctx);
    }
  }
  return { order: result.order, specimen: result.specimen, duplicate: result.duplicate };
}
