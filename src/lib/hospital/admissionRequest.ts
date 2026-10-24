import { prisma } from "@/lib/db";
import { BedStatus } from "@prisma/client";
import { transitionBed, InvalidBedTransitionError } from "./bed";
import { admitPatient } from "./admission";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import type { AdmissionRequest, AdmissionRequestStatus, Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * Move a request from the status read to `to` (compare-and-set: a concurrent
 * change makes this fail instead of being overwritten) and emit
 * AdmissionRequestStatusChanged in the same transaction.
 */
async function moveRequest(
  tx: Tx, request: AdmissionRequest, to: "PENDING" | "DEFERRED" | "REJECTED" | "CANCELLED", byUserId: string | undefined,
  data: Prisma.AdmissionRequestUncheckedUpdateManyInput = {}, releasedBedId?: string | null,
) {
  const r = await tx.admissionRequest.updateMany({ where: { id: request.id, status: request.status }, data: { ...data, status: to } });
  if (r.count !== 1) throw new AdmissionRequestNotPendingError(request.status);
  await emitFacilityEvent(tx, {
    type: "AdmissionRequestStatusChanged", aggregateId: request.id, facilityId: request.facilityId, actorUserId: byUserId, encounterId: request.encounterId,
    payload: {
      admissionRequestId: request.id, encounterId: request.encounterId, patientId: request.patientId,
      from: request.status as Exclude<AdmissionRequestStatus, "ADMITTED" | "REJECTED" | "CANCELLED">, to,
      ...(releasedBedId ? { releasedBedId } : {}),
    },
  });
  return tx.admissionRequest.findUniqueOrThrow({ where: { id: request.id } });
}

/**
 * Admission-request layer (brief §28-32) — sits ON TOP of the existing
 * `admitPatient()`/bed-state-machine (src/lib/hospital/{admission,bed}.ts),
 * never duplicating it. "Allocate" reserves a specific bed via the
 * existing `transitionBed()` (AVAILABLE -> RESERVED, a transition that
 * already existed in bed.ts's legal-transitions table but nothing used
 * until now); "confirm" calls the existing `admitPatient()`, which this
 * phase relaxed to also accept a bed the request itself reserved.
 */

export class AdmissionRequestNotPendingError extends Error {
  constructor(status: string) {
    super(`Admission request is not actionable from status ${status}.`);
  }
}

export async function createAdmissionRequest(input: {
  patientId: string;
  encounterId: string;
  facilityId: string;
  departmentId?: string;
  requestedByStaffId: string;
  requestedWardType?: string;
  isolationRequired?: boolean;
  genderRestriction?: string;
  priority?: "ROUTINE" | "URGENT" | "EMERGENCY";
  reason: string;
  expectedLosDays?: number;
  /** Week 5c: a planned admission's expected date (pre-arrival check-in opens 24 hours before). */
  plannedAdmissionAt?: Date | null;
  byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.admissionRequest.create({
      data: {
        plannedAdmissionAt: input.plannedAdmissionAt ?? null,
        patientId: input.patientId,
        encounterId: input.encounterId,
        facilityId: input.facilityId,
        departmentId: input.departmentId,
        requestedByStaffId: input.requestedByStaffId,
        requestedWardType: input.requestedWardType as never,
        isolationRequired: input.isolationRequired ?? false,
        genderRestriction: input.genderRestriction,
        priority: input.priority ?? "ROUTINE",
        reason: input.reason,
        expectedLosDays: input.expectedLosDays,
      },
    });
    await tx.auditEvent.create({
      data: { type: "hospital.admissionRequest.created", userId: input.byUserId, detail: { requestId: request.id, patientId: input.patientId } },
    });
    await emitFacilityEvent(tx, {
      type: "AdmissionRequested", aggregateId: request.id, facilityId: input.facilityId, actorUserId: input.byUserId, encounterId: input.encounterId,
      payload: { admissionRequestId: request.id, encounterId: input.encounterId, patientId: input.patientId, priority: request.priority },
    });
    return request;
  });
}

/** Allocate a bed: reserves it (AVAILABLE -> RESERVED) and marks the request BED_RESERVED, atomically. */
export async function allocateBed(requestId: string, bedId: string, reviewedByStaffId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.admissionRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (!["PENDING", "DEFERRED"].includes(request.status)) throw new AdmissionRequestNotPendingError(request.status);

    await transitionBed(bedId, BedStatus.RESERVED, { reason: `Admission request ${requestId}`, byUserId, patientId: request.patientId, encounterId: request.encounterId }, tx);

    const updated = await tx.admissionRequest.update({
      where: { id: requestId },
      data: { status: "BED_RESERVED", reservedBedId: bedId, reviewedByStaffId, reviewedAt: new Date() },
    });
    await tx.auditEvent.create({
      data: { type: "hospital.admissionRequest.bedReserved", userId: byUserId, detail: { requestId, bedId } },
    });
    await emitFacilityEvent(tx, {
      type: "BedReserved", aggregateId: requestId, facilityId: request.facilityId, actorUserId: byUserId, encounterId: request.encounterId,
      payload: { admissionRequestId: requestId, bedId, patientId: request.patientId },
    });
    return updated;
  });
}

/** Releases a reservation without admitting — "change destination" (brief §29) or an abandoned hold. */
export async function releaseReservation(requestId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.admissionRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (request.status !== "BED_RESERVED" || !request.reservedBedId) throw new AdmissionRequestNotPendingError(request.status);
    await transitionBed(request.reservedBedId, BedStatus.AVAILABLE, { reason: "Admission request reservation released", byUserId }, tx);
    return moveRequest(tx, request, "PENDING", byUserId, { reservedBedId: null }, request.reservedBedId);
  });
}

export async function deferRequest(requestId: string, byUserId?: string) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.admissionRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (request.status !== "PENDING") throw new AdmissionRequestNotPendingError(request.status);
    return moveRequest(tx, request, "DEFERRED", byUserId);
  });
}

export async function rejectRequest(requestId: string, reason: string, reviewedByStaffId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.admissionRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (!["PENDING", "DEFERRED"].includes(request.status)) throw new AdmissionRequestNotPendingError(request.status);
    const updated = await moveRequest(tx, request, "REJECTED", byUserId, { rejectionReason: reason, reviewedByStaffId, reviewedAt: new Date() });
    await tx.auditEvent.create({ data: { type: "hospital.admissionRequest.rejected", userId: byUserId, detail: { requestId, reason } } });
    return updated;
  });
}

export async function cancelRequest(requestId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.admissionRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (["ADMITTED", "REJECTED", "CANCELLED"].includes(request.status)) throw new AdmissionRequestNotPendingError(request.status);
    if (request.status === "BED_RESERVED" && request.reservedBedId) {
      try {
        await transitionBed(request.reservedBedId, BedStatus.AVAILABLE, { reason: "Admission request cancelled", byUserId }, tx);
      } catch (err) {
        if (!(err instanceof InvalidBedTransitionError)) throw err;
      }
    }
    const updated = await moveRequest(tx, request, "CANCELLED", byUserId, {}, request.status === "BED_RESERVED" ? request.reservedBedId : null);
    await tx.auditEvent.create({ data: { type: "hospital.admissionRequest.cancelled", userId: byUserId, detail: { requestId } } });
    return updated;
  });
}

/** Confirms admission: calls the EXISTING admitPatient() with the reserved bed, then links the request to the resulting Admission. */
export async function confirmAdmissionRequest(requestId: string, byUserId: string) {
  const request = await prisma.admissionRequest.findUniqueOrThrow({ where: { id: requestId } });
  if (request.status !== "BED_RESERVED" || !request.reservedBedId) throw new AdmissionRequestNotPendingError(request.status);

  const admission = await admitPatient({
    encounterId: request.encounterId,
    bedId: request.reservedBedId,
    admittingStaffId: request.requestedByStaffId,
    reason: request.reason,
    expectedLosDays: request.expectedLosDays ?? undefined,
    byUserId,
  });

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.admissionRequest.update({ where: { id: requestId }, data: { status: "ADMITTED", admissionId: admission.id } });
    await tx.auditEvent.create({ data: { type: "hospital.admissionRequest.confirmed", userId: byUserId, detail: { requestId, admissionId: admission.id } } });
    return u;
  });

  return { request: updated, admission };
}

