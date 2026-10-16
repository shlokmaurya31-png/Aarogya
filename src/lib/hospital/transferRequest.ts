import { prisma } from "@/lib/db";
import { BedStatus } from "@prisma/client";
import { transitionBed, InvalidBedTransitionError } from "./bed";
import { transferPatientInTx } from "./admission";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import type { Prisma, TransferRequest, TransferRequestStatus } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/** TransferRequestStatusChanged, in the writer's transaction, correlated by the admission's encounter. */
async function emitTransferStatus(tx: Tx, r: TransferRequest, from: TransferRequestStatus | null, byUserId?: string) {
  const admission = await tx.admission.findUniqueOrThrow({ where: { id: r.admissionId }, select: { encounterId: true } });
  await emitFacilityEvent(tx, {
    type: "TransferRequestStatusChanged", aggregateId: r.id, facilityId: r.facilityId, actorUserId: byUserId, encounterId: admission.encounterId,
    payload: {
      transferRequestId: r.id, admissionId: r.admissionId, patientId: r.patientId, encounterId: admission.encounterId,
      from, to: r.status, priority: r.priority,
      ...(r.reservedBedId ? { reservedBedId: r.reservedBedId } : {}),
      ...(r.transferId ? { transferId: r.transferId } : {}),
    },
  });
}

/** Compare-and-set the request from the status read to `to`, then emit. */
async function moveTransferRequest(tx: Tx, r: TransferRequest, to: TransferRequestStatus, data: Prisma.TransferRequestUncheckedUpdateManyInput, byUserId?: string) {
  const res = await tx.transferRequest.updateMany({ where: { id: r.id, status: r.status }, data: { ...data, status: to } });
  if (res.count !== 1) throw new TransferRequestNotActionableError(r.status);
  const updated = await tx.transferRequest.findUniqueOrThrow({ where: { id: r.id } });
  await emitTransferStatus(tx, updated, r.status, byUserId);
  return updated;
}

/**
 * Internal-transfer request layer (brief §34-36) — sits on top of the
 * existing `Transfer`/`transferPatient()` machinery, same pattern as
 * admissionRequest.ts. "Complete" calls the existing `transferPatient()`
 * (relaxed to accept a bed this request reserved), which writes the real
 * `Transfer` row this request then links to.
 */

export class TransferRequestNotActionableError extends Error {
  constructor(status: string) {
    super(`Transfer request is not actionable from status ${status}.`);
  }
}

export class TransferSafetyError extends Error {}

export async function createTransferRequest(input: {
  admissionId: string;
  facilityId: string;
  patientId: string;
  requestedByStaffId: string;
  reason: string;
  destinationWardType?: string;
  isolationRequired?: boolean;
  genderRestriction?: string;
  priority?: "ROUTINE" | "URGENT" | "EMERGENCY";
  transportRequired?: boolean;
  clinicalHandoverRequired?: boolean;
  byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    // Transfer safety (brief §35): reject up front if the admission is already discharged,
    // or already has an active (non-terminal) transfer request pending.
    const admission = await tx.admission.findUniqueOrThrow({ where: { id: input.admissionId }, include: { discharge: true } });
    if (admission.discharge?.dischargedAt) throw new TransferSafetyError("Patient has already been discharged.");
    const activePending = await tx.transferRequest.findFirst({
      where: { admissionId: input.admissionId, status: { notIn: ["COMPLETED", "CANCELLED", "REJECTED"] } },
    });
    if (activePending) throw new TransferSafetyError("A transfer request is already pending for this admission.");

    const request = await tx.transferRequest.create({
      data: {
        admissionId: input.admissionId,
        facilityId: input.facilityId,
        patientId: input.patientId,
        requestedByStaffId: input.requestedByStaffId,
        reason: input.reason,
        destinationWardType: input.destinationWardType as never,
        isolationRequired: input.isolationRequired ?? false,
        genderRestriction: input.genderRestriction,
        priority: input.priority ?? "ROUTINE",
        transportRequired: input.transportRequired ?? false,
        clinicalHandoverRequired: input.clinicalHandoverRequired ?? true,
      },
    });
    await tx.auditEvent.create({ data: { type: "hospital.transferRequest.created", userId: input.byUserId, detail: { requestId: request.id, admissionId: input.admissionId } } });
    await emitTransferStatus(tx, request, null, input.byUserId);
    return request;
  });
}

export async function acceptTransferRequest(requestId: string, acceptedByStaffId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.transferRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (request.status !== "REQUESTED") throw new TransferRequestNotActionableError(request.status);
    const updated = await moveTransferRequest(tx, request, "ACCEPTED", { acceptedByStaffId }, byUserId);
    await tx.auditEvent.create({ data: { type: "hospital.transferRequest.accepted", userId: byUserId, detail: { requestId } } });
    return updated;
  });
}

export async function reserveBedForTransfer(requestId: string, bedId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.transferRequest.findUniqueOrThrow({ where: { id: requestId }, include: { admission: true } });
    if (request.status !== "ACCEPTED") throw new TransferRequestNotActionableError(request.status);
    if (bedId === request.admission.bedId) throw new TransferSafetyError("Destination bed is the same as the patient's current bed.");

    await transitionBed(bedId, BedStatus.RESERVED, { reason: `Transfer request ${requestId}`, byUserId, patientId: request.patientId }, tx);

    const updated = await moveTransferRequest(tx, request, "BED_RESERVED", { reservedBedId: bedId }, byUserId);
    await tx.auditEvent.create({ data: { type: "hospital.transferRequest.bedReserved", userId: byUserId, detail: { requestId, bedId } } });
    return updated;
  });
}

export async function markPatientInTransit(requestId: string, byUserId?: string) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.transferRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (request.status !== "BED_RESERVED") throw new TransferRequestNotActionableError(request.status);
    return moveTransferRequest(tx, request, "PATIENT_IN_TRANSIT", {}, byUserId);
  });
}

/**
 * Executes the transfer and completes the request in ONE transaction: the bed
 * move, the EncounterLocation rows (D5: the location history), the Transfer
 * and the request's COMPLETED status commit together or not at all.
 */
export async function completeTransferRequest(requestId: string, byUserId: string) {
  const { updated, transfer, auditContext } = await prisma.$transaction(async (tx) => {
    const request = await tx.transferRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (!["BED_RESERVED", "PATIENT_IN_TRANSIT"].includes(request.status) || !request.reservedBedId) {
      throw new TransferRequestNotActionableError(request.status);
    }
    const { transfer, auditContext } = await transferPatientInTx(tx, {
      admissionId: request.admissionId,
      toBedId: request.reservedBedId,
      reason: request.reason,
      byUserId,
    });
    // Compare-and-set on the status read above, so two completions can't both win.
    const cas = await tx.transferRequest.updateMany({
      where: { id: requestId, status: request.status },
      data: { status: "COMPLETED", transferId: transfer.id, completedAt: new Date() },
    });
    if (cas.count !== 1) throw new TransferRequestNotActionableError("COMPLETED");
    await tx.auditEvent.create({ data: { type: "hospital.transferRequest.completed", userId: byUserId, detail: { requestId, transferId: transfer.id } } });
    const completed = await tx.transferRequest.findUniqueOrThrow({ where: { id: requestId } });
    await emitTransferStatus(tx, completed, request.status, byUserId);
    return { updated: completed, transfer, auditContext };
  });
  await recordAuditEvent("hospital.admission.transferred", byUserId, { admissionId: updated.admissionId, toBedId: updated.reservedBedId }, auditContext);
  return { request: updated, transfer };
}

export async function cancelTransferRequest(requestId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.transferRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (["COMPLETED", "CANCELLED", "REJECTED"].includes(request.status)) throw new TransferRequestNotActionableError(request.status);
    if (request.reservedBedId) {
      try {
        await transitionBed(request.reservedBedId, BedStatus.AVAILABLE, { reason: "Transfer request cancelled", byUserId }, tx);
      } catch (err) {
        if (!(err instanceof InvalidBedTransitionError)) throw err;
      }
    }
    return moveTransferRequest(tx, request, "CANCELLED", {}, byUserId);
  });
}
