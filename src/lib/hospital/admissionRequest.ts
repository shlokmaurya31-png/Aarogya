import { prisma } from "@/lib/db";
import { BedStatus } from "@prisma/client";
import { transitionBed, InvalidBedTransitionError } from "./bed";
import { admitPatient } from "./admission";

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
  byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.admissionRequest.create({
      data: {
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
    return updated;
  });
}

/** Releases a reservation without admitting — "change destination" (brief §29) or an abandoned hold. */
export async function releaseReservation(requestId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.admissionRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (request.status !== "BED_RESERVED" || !request.reservedBedId) throw new AdmissionRequestNotPendingError(request.status);
    await transitionBed(request.reservedBedId, BedStatus.AVAILABLE, { reason: "Admission request reservation released", byUserId }, tx);
    return tx.admissionRequest.update({ where: { id: requestId }, data: { status: "PENDING", reservedBedId: null } });
  });
}

export async function deferRequest(requestId: string) {
  const request = await prisma.admissionRequest.findUniqueOrThrow({ where: { id: requestId } });
  if (request.status !== "PENDING") throw new AdmissionRequestNotPendingError(request.status);
  return prisma.admissionRequest.update({ where: { id: requestId }, data: { status: "DEFERRED" } });
}

export async function rejectRequest(requestId: string, reason: string, reviewedByStaffId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.admissionRequest.findUniqueOrThrow({ where: { id: requestId } });
    if (!["PENDING", "DEFERRED"].includes(request.status)) throw new AdmissionRequestNotPendingError(request.status);
    const updated = await tx.admissionRequest.update({
      where: { id: requestId },
      data: { status: "REJECTED", rejectionReason: reason, reviewedByStaffId, reviewedAt: new Date() },
    });
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
    const updated = await tx.admissionRequest.update({ where: { id: requestId }, data: { status: "CANCELLED" } });
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

