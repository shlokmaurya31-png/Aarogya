import { prisma } from "@/lib/db";
import { BedStatus } from "@prisma/client";
import { transitionBed, InvalidBedTransitionError } from "./bed";
import { transferPatient } from "./admission";

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
    return request;
  });
}

export async function acceptTransferRequest(requestId: string, acceptedByStaffId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.transferRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (request.status !== "REQUESTED") throw new TransferRequestNotActionableError(request.status);
    const updated = await tx.transferRequest.update({ where: { id: requestId }, data: { status: "ACCEPTED", acceptedByStaffId } });
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

    const updated = await tx.transferRequest.update({ where: { id: requestId }, data: { status: "BED_RESERVED", reservedBedId: bedId } });
    await tx.auditEvent.create({ data: { type: "hospital.transferRequest.bedReserved", userId: byUserId, detail: { requestId, bedId } } });
    return updated;
  });
}

export async function markPatientInTransit(requestId: string) {
  const request = await prisma.transferRequest.findUniqueOrThrow({ where: { id: requestId } });
  if (request.status !== "BED_RESERVED") throw new TransferRequestNotActionableError(request.status);
  return prisma.transferRequest.update({ where: { id: requestId }, data: { status: "PATIENT_IN_TRANSIT" } });
}

/** Executes the transfer: calls the EXISTING transferPatient(), then links the resulting Transfer row. */
export async function completeTransferRequest(requestId: string, byUserId: string) {
  const request = await prisma.transferRequest.findUniqueOrThrow({ where: { id: requestId } });
  if (!["BED_RESERVED", "PATIENT_IN_TRANSIT"].includes(request.status) || !request.reservedBedId) {
    throw new TransferRequestNotActionableError(request.status);
  }

  const transfer = await transferPatient({
    admissionId: request.admissionId,
    toBedId: request.reservedBedId,
    reason: request.reason,
    byUserId,
  });

  return prisma.$transaction(async (tx) => {
    const updated = await tx.transferRequest.update({
      where: { id: requestId },
      data: { status: "COMPLETED", transferId: transfer.id, completedAt: new Date() },
    });
    await tx.auditEvent.create({ data: { type: "hospital.transferRequest.completed", userId: byUserId, detail: { requestId, transferId: transfer.id } } });
    return { request: updated, transfer };
  });
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
    return tx.transferRequest.update({ where: { id: requestId }, data: { status: "CANCELLED" } });
  });
}
