import { $Enums } from "@prisma/client";
import { createTask } from "@/lib/hospital/task";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { parseOptionalEnum } from "@/lib/enumValue";
import { createOrderEnvelope, syncOrderStatus } from "./orderEnvelope";
import { mapDiagnosticPriorityToOrderPriority } from "./diagnosticsLifecycle";
import { createPricedChargeIfNotExists } from "./billing/chargeCapture";
import { PriceNotFoundError } from "./billing/pricing";
import { markEncounterInvestigating } from "./labOrder";

/**
 * Place an imaging order (POST /api/hospital/orders/imaging), in one
 * transaction: Order envelope + ImagingOrder + the priced charge (§5.2) + the
 * preparation task, and the encounter moves to INVESTIGATING. Same 15 s
 * resubmission dedupe as lab. ImagingOrderPlaced is wired here in §9 step 6.
 */
export async function placeImagingOrder(input: {
  facilityId: string;
  staffId: string;
  byUserId: string;
  encounterId: unknown;
  patientId: unknown;
  modality: unknown;
  studyDescription: unknown;
  priority?: unknown;
  catalogStudyId?: unknown;
}) {
  const { facilityId, staffId } = input;
  const { encounterId, patientId, modality, studyDescription } = input;
  if (!encounterId || !patientId || !modality || !studyDescription) throw new BadRequestError("encounterId, patientId, modality and studyDescription are required.");
  if (typeof encounterId !== "string" || typeof patientId !== "string") throw new BadRequestError("encounterId and patientId must be strings.");
  if (typeof studyDescription !== "string" || studyDescription.length > 500) throw new BadRequestError("studyDescription must be a string of at most 500 characters.");
  if (typeof modality !== "string" || modality.length > 100) throw new BadRequestError("modality must be a string of at most 100 characters.");
  const priority = parseOptionalEnum($Enums.Priority, input.priority, "priority");
  const catalogStudyId = typeof input.catalogStudyId === "string" ? input.catalogStudyId : undefined;

  const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
  if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");
  if (encounter.patientId !== patientId) throw new BadRequestError("patientId does not match the encounter's patient.");

  let catalogStudy = null;
  if (catalogStudyId) {
    catalogStudy = await prisma.imagingCatalog.findUnique({ where: { id: catalogStudyId } });
    if (!catalogStudy || (catalogStudy.facilityId && catalogStudy.facilityId !== facilityId)) throw new NotFoundError("Catalog study not found.");
  }

  const result = await prisma.$transaction(async (tx) => {
    const recentDuplicate = await tx.imagingOrder.findFirst({
      where: { encounterId, studyDescription, orderedByStaffId: staffId, orderedAt: { gte: new Date(Date.now() - 15_000) } },
      orderBy: { orderedAt: "desc" },
    });
    if (recentDuplicate) return { order: recentDuplicate, duplicate: true as const, charge: null, task: null };

    const envelope = await createOrderEnvelope(tx, {
      facilityId, encounterId, patientId, orderingStaffId: staffId, orderType: "IMAGING",
      priority: mapDiagnosticPriorityToOrderPriority(priority),
    });
    const order = await tx.imagingOrder.create({
      data: {
        encounterId, patientId, modality, studyDescription, priority: priority ?? "ROUTINE",
        orderedByStaffId: staffId, orderId: envelope.id, catalogStudyId,
      },
    });
    await syncOrderStatus(tx, "IMAGING", order.id);

    const chargeBase = { encounterId, patientId, facilityId, category: "IMAGING", sourceType: "ImagingOrder", sourceId: order.id, postedByUserId: staffId };
    let charged;
    try {
      charged = await createPricedChargeIfNotExists(tx, { ...chargeBase, description: `Imaging: ${studyDescription}`, chargeCode: catalogStudy?.code ?? `IMAGING:${modality.toUpperCase()}` });
    } catch (err) {
      if (!(err instanceof PriceNotFoundError)) throw err;
      charged = await createPricedChargeIfNotExists(tx, { ...chargeBase, description: `Imaging: ${studyDescription} (generic tariff)`, chargeCode: "IMAGING:GENERIC" });
    }

    const task = await createTask(tx, {
      facilityId, title: `Prepare patient for ${modality}: ${studyDescription}`, type: "IMAGING_PREP", source: "ORDER",
      patientId, encounterId, orderId: envelope.id, createdByStaffId: staffId, priority: priority ?? "ROUTINE",
    }, input.byUserId);
    await markEncounterInvestigating(tx, encounterId);
    return { order, duplicate: false as const, charge: charged.charge, task };
  });

  if (!result.duplicate) {
    const ctx = { facilityId, patientId, encounterId };
    await recordAuditEvent("hospital.imaging.ordered", input.byUserId, { orderId: result.order.id }, ctx);
    await recordAuditEvent("hospital.task.created", input.byUserId, { taskId: result.task.id, type: "IMAGING_PREP", orderId: result.order.id }, ctx);
    if (result.charge) {
      await recordAuditEvent("hospital.billing.chargeCreated", input.byUserId, { chargeId: result.charge.id, netAmountMinor: result.charge.netAmountMinor, sourceType: "ImagingOrder", sourceId: result.order.id }, ctx);
    }
  }
  return { order: result.order, duplicate: result.duplicate };
}
