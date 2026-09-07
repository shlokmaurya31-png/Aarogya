import type { Prisma, RequisitionPriority } from "@prisma/client";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { assertItemInFacility } from "@/lib/hospital/inventory/facilityScope";
import { nextPurchaseRequisitionSequence, formatSequenceNumber } from "./sequence";

type Tx = Prisma.TransactionClient;

export class RequisitionConcurrencyError extends BadRequestError {
  constructor(status: string) {
    super(`Requisition is not in the expected state (currently ${status}).`);
  }
}

export class SameActorApprovalError extends BadRequestError {
  constructor() {
    super("The same staff member cannot both request and approve a requisition.");
  }
}

export async function createRequisitionDraft(
  tx: Tx,
  input: { facilityId: string; departmentId: string; requestedByStaffId: string; justification: string; priority?: RequisitionPriority; requiredByDate?: Date }
) {
  const department = await tx.department.findUniqueOrThrow({ where: { id: input.departmentId } });
  if (department.facilityId !== input.facilityId) throw new BadRequestError("Department does not belong to this facility.");
  return tx.purchaseRequisition.create({
    data: {
      facilityId: input.facilityId,
      departmentId: input.departmentId,
      requestedByStaffId: input.requestedByStaffId,
      justification: input.justification,
      priority: input.priority ?? "ROUTINE",
      requiredByDate: input.requiredByDate,
      idempotencyKey: `req-draft-${input.facilityId}-${input.requestedByStaffId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
}

export async function addRequisitionLine(tx: Tx, requisitionId: string, input: { itemId: string; quantity: number; unit: Prisma.PurchaseRequisitionLineCreateInput["unit"]; notes?: string }) {
  const requisition = await tx.purchaseRequisition.findUniqueOrThrow({ where: { id: requisitionId } });
  if (requisition.status !== "DRAFT") throw new BadRequestError("Lines can only be added while the requisition is DRAFT.");
  if (input.quantity <= 0) throw new BadRequestError("Quantity must be positive.");
  await assertItemInFacility(tx, input.itemId, requisition.facilityId);
  return tx.purchaseRequisitionLine.create({ data: { requisitionId, itemId: input.itemId, quantity: input.quantity, unit: input.unit, notes: input.notes } });
}

/** Assigns requisitionNumber atomically via the guarded sequence CAS, inside the same guarded status transition. */
export async function submitRequisition(tx: Tx, requisitionId: string) {
  const requisition = await tx.purchaseRequisition.findUniqueOrThrow({ where: { id: requisitionId }, include: { lines: true } });
  if (requisition.lines.length === 0) throw new BadRequestError("Cannot submit a requisition with no lines.");

  const fiscalYear = new Date().getFullYear();
  const seq = await nextPurchaseRequisitionSequence(tx, { facilityId: requisition.facilityId, fiscalYear });
  const requisitionNumber = formatSequenceNumber("REQ", fiscalYear, seq);

  const result = await tx.purchaseRequisition.updateMany({
    where: { id: requisitionId, status: "DRAFT" },
    data: { status: "SUBMITTED", requisitionNumber, submittedAt: new Date() },
  });
  if (result.count !== 1) throw new RequisitionConcurrencyError(requisition.status);
  return tx.purchaseRequisition.findUniqueOrThrow({ where: { id: requisitionId } });
}

/** Guarded status CAS closes the requisition-approval race (#8). Same-actor guard prevents silent self-approval. Sets each line's approvedQuantity = requested quantity, immutable from here on (service-level guard — no route ever accepts a client-supplied approvedQuantity edit after this point). */
export async function approveRequisition(tx: Tx, requisitionId: string, input: { approvedByStaffId: string }) {
  const requisition = await tx.purchaseRequisition.findUniqueOrThrow({ where: { id: requisitionId }, include: { lines: true } });
  if (requisition.requestedByStaffId === input.approvedByStaffId) throw new SameActorApprovalError();

  const result = await tx.purchaseRequisition.updateMany({
    where: { id: requisitionId, status: "SUBMITTED" },
    data: { status: "APPROVED", approvedByStaffId: input.approvedByStaffId, approvedAt: new Date() },
  });
  if (result.count !== 1) throw new RequisitionConcurrencyError(requisition.status);

  for (const line of requisition.lines) {
    await tx.purchaseRequisitionLine.update({ where: { id: line.id }, data: { approvedQuantity: line.quantity } });
  }
  return tx.purchaseRequisition.findUniqueOrThrow({ where: { id: requisitionId }, include: { lines: true } });
}

export async function rejectRequisition(tx: Tx, requisitionId: string, input: { rejectedByStaffId: string; reason: string }) {
  const result = await tx.purchaseRequisition.updateMany({
    where: { id: requisitionId, status: "SUBMITTED" },
    data: { status: "REJECTED", rejectedByStaffId: input.rejectedByStaffId, rejectedAt: new Date(), rejectionReason: input.reason },
  });
  if (result.count !== 1) throw new RequisitionConcurrencyError("not SUBMITTED");
  return tx.purchaseRequisition.findUniqueOrThrow({ where: { id: requisitionId } });
}

export async function cancelRequisition(tx: Tx, requisitionId: string, input: { reason: string }) {
  const requisition = await tx.purchaseRequisition.findUniqueOrThrow({ where: { id: requisitionId } });
  if (!["DRAFT", "SUBMITTED", "APPROVED"].includes(requisition.status)) throw new RequisitionConcurrencyError(requisition.status);
  const result = await tx.purchaseRequisition.updateMany({
    where: { id: requisitionId, status: requisition.status },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelledReason: input.reason },
  });
  if (result.count !== 1) throw new RequisitionConcurrencyError(requisition.status);
  return tx.purchaseRequisition.findUniqueOrThrow({ where: { id: requisitionId } });
}

/** A "revision" is cancel + clone into a new DRAFT, never an in-place edit of an already-approved requisition. */
export async function reviseApprovedRequisition(tx: Tx, requisitionId: string, input: { requestedByStaffId: string; justification: string; reason: string }) {
  const original = await tx.purchaseRequisition.findUnique({ where: { id: requisitionId }, include: { lines: true } });
  if (!original) throw new NotFoundError("Requisition not found.");
  if (original.status !== "APPROVED") throw new BadRequestError("Only an APPROVED requisition can be revised.");

  await cancelRequisition(tx, requisitionId, { reason: input.reason });

  const clone = await tx.purchaseRequisition.create({
    data: {
      facilityId: original.facilityId,
      departmentId: original.departmentId,
      requestedByStaffId: input.requestedByStaffId,
      justification: input.justification,
      priority: original.priority,
      requiredByDate: original.requiredByDate,
      supersedesRequisitionId: original.id,
      idempotencyKey: `req-revision-${original.id}-${Date.now()}`,
    },
  });
  for (const line of original.lines) {
    await tx.purchaseRequisitionLine.create({ data: { requisitionId: clone.id, itemId: line.itemId, quantity: line.quantity, unit: line.unit, notes: line.notes } });
  }
  return clone;
}
