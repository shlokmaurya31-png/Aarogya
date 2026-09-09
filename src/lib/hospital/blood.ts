import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import type { Prisma, AboGroup, RhStatus, BloodUnitStatus, BloodRequestStatus, BloodRequestPriority } from "@prisma/client";

/**
 * Blood Bank & Transfusion service (Phase B4). Composes the canonical
 * Patient/Encounter/ADT/ClinicalNote/Item-ItemLot/AuditEvent systems — no
 * parallel domain models. Blood units are SERIALIZED: a unit's own `status`
 * column is the concurrency-control point, mutated only through
 * `guardedUnitTransition` (a single atomic updateMany with a status precondition
 * → exactly one concurrent caller wins). Every child record copies
 * patient/encounter/facility from its parent request/unit, never from the
 * client (wrong-patient-safe by construction).
 *
 * HARD SAFETY BOUNDARY: this file contains NO ABO/Rh compatibility algorithm,
 * NO antibody-screen or crossmatch interpretation, NO severity/reaction
 * inference, NO dosing/threshold logic. Compatibility is an explicitly-recorded,
 * authorized-verified laboratory result; issue is gated on that recorded result
 * (or an explicit emergency release), never derived from ABO equality.
 */

// ── Blood unit state machine ──────────────────────────────────────────────
const UNIT_TRANSITIONS: Record<BloodUnitStatus, BloodUnitStatus[]> = {
  QUARANTINED: ["AVAILABLE", "WASTED", "DISCARDED", "EXPIRED"],
  AVAILABLE: ["RESERVED", "ISSUED", "QUARANTINED", "WASTED", "EXPIRED", "DISCARDED"],
  RESERVED: ["AVAILABLE", "ISSUED", "QUARANTINED", "WASTED"],
  ISSUED: ["IN_TRANSIT", "TRANSFUSING", "RETURNED", "QUARANTINED", "WASTED"],
  IN_TRANSIT: ["ISSUED", "TRANSFUSING", "RETURNED", "QUARANTINED"],
  TRANSFUSING: ["TRANSFUSED", "QUARANTINED", "WASTED"],
  TRANSFUSED: ["QUARANTINED"],
  RETURNED: ["AVAILABLE", "QUARANTINED", "WASTED", "DISCARDED"],
  WASTED: [],
  DISCARDED: [],
  EXPIRED: ["WASTED", "DISCARDED"],
};

export class BloodUnitTransitionError extends BadRequestError {
  constructor(from: string, to: string) {
    super(`Illegal blood-unit transition ${from} -> ${to}.`);
  }
}
export class BloodUnitConflictError extends BadRequestError {
  constructor(message = "This blood unit changed state concurrently. Refresh and try again.") {
    super(message);
  }
}

export function isUnitTransitionAllowed(from: BloodUnitStatus, to: BloodUnitStatus): boolean {
  return UNIT_TRANSITIONS[from]?.includes(to) ?? false;
}

type Tx = Prisma.TransactionClient;

/**
 * The concurrency-critical primitive. One atomic UPDATE guarded on the unit's
 * current status (and facility) — the read-check and the write are the same
 * statement, so two concurrent transitions can never both win. Returns nothing;
 * throws BloodUnitConflictError when the guard matched 0 rows (lost race or
 * illegal precondition).
 */
async function guardedUnitTransition(
  tx: Tx,
  input: { unitId: string; facilityId: string; from: BloodUnitStatus[]; to: BloodUnitStatus; data?: Prisma.BloodUnitUpdateManyMutationInput }
): Promise<void> {
  const result = await tx.bloodUnit.updateMany({
    where: { id: input.unitId, facilityId: input.facilityId, status: { in: input.from } },
    data: { status: input.to, ...(input.data ?? {}) },
  });
  if (result.count !== 1) throw new BloodUnitConflictError();
}

async function loadUnit(tx: Tx, unitId: string, facilityId: string) {
  const unit = await tx.bloodUnit.findUnique({ where: { id: unitId } });
  if (!unit || unit.facilityId !== facilityId) throw new NotFoundError("Blood unit not found.");
  return unit;
}

/** Server-side expiry/recall gate — never issue/reserve an expired, recalled, or non-available unit. */
function assertUnitIssuable(unit: { status: BloodUnitStatus; expiresAt: Date | null; recalled: boolean }) {
  if (unit.recalled) throw new BadRequestError("Unit is under recall and cannot be issued.");
  if (unit.expiresAt && unit.expiresAt.getTime() <= Date.now()) throw new BadRequestError("Unit has expired and cannot be issued.");
}

// ── Blood product master ──────────────────────────────────────────────────
export async function createBloodProduct(input: {
  facilityId: string; code: string; name: string; componentType: string; defaultUnitDescription?: string; storageRequirement?: string; itemId?: string; byUserId: string;
}) {
  if (input.itemId) {
    const item = await prisma.item.findUnique({ where: { id: input.itemId } });
    if (!item || (item.facilityId && item.facilityId !== input.facilityId)) throw new NotFoundError("Linked inventory item not found in this facility.");
  }
  const product = await prisma.bloodProduct.create({
    data: { facilityId: input.facilityId, code: input.code, name: input.name, componentType: input.componentType, defaultUnitDescription: input.defaultUnitDescription, storageRequirement: input.storageRequirement, itemId: input.itemId },
  });
  await recordAuditEvent("hospital.blood.productConfigured", input.byUserId, { productId: product.id, code: product.code }, { facilityId: input.facilityId });
  return product;
}

// ── Blood unit registration + disposition ─────────────────────────────────
export async function registerBloodUnit(input: {
  facilityId: string; productId: string; unitNumber: string; aboGroup?: AboGroup; rhStatus?: RhStatus; collectedAt?: Date; expiresAt?: Date;
  itemLotId?: string; locationId?: string; donorReference?: string; sourceOrganization?: string; collectionEventRef?: string; registeredByStaffId: string; byUserId: string;
}) {
  const product = await prisma.bloodProduct.findUnique({ where: { id: input.productId } });
  if (!product || product.facilityId !== input.facilityId) throw new NotFoundError("Blood product not found.");
  if (input.itemLotId) {
    const lot = await prisma.itemLot.findUnique({ where: { id: input.itemLotId } });
    if (!lot || lot.facilityId !== input.facilityId) throw new NotFoundError("Item lot not found in this facility.");
  }
  if (input.locationId) {
    const loc = await prisma.stockLocation.findUnique({ where: { id: input.locationId } });
    if (!loc || loc.facilityId !== input.facilityId) throw new NotFoundError("Location not found in this facility.");
  }
  // A blood group provided at registration is a recorded value, not a
  // confirmed authorized typing — that requires recordUnitTyping + verify.
  const unit = await prisma.bloodUnit.create({
    data: {
      facilityId: input.facilityId, productId: input.productId, unitNumber: input.unitNumber,
      aboGroup: input.aboGroup, rhStatus: input.rhStatus, collectedAt: input.collectedAt, expiresAt: input.expiresAt,
      itemLotId: input.itemLotId, locationId: input.locationId, donorReference: input.donorReference,
      sourceOrganization: input.sourceOrganization, collectionEventRef: input.collectionEventRef,
      quarantineReason: "Awaiting testing/release", registeredByStaffId: input.registeredByStaffId,
    },
  });
  await recordAuditEvent("hospital.blood.unitRegistered", input.byUserId, { unitId: unit.id, unitNumber: unit.unitNumber, productId: input.productId }, { facilityId: input.facilityId });
  return unit;
}

export async function releaseUnit(input: { unitId: string; facilityId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const unit = await loadUnit(tx, input.unitId, input.facilityId);
    if (unit.recalled) throw new BadRequestError("A recalled unit cannot be released to available stock.");
    if (unit.expiresAt && unit.expiresAt.getTime() <= Date.now()) throw new BadRequestError("An expired unit cannot be released to available stock.");
    if (!isUnitTransitionAllowed(unit.status, "AVAILABLE")) throw new BloodUnitTransitionError(unit.status, "AVAILABLE");
    await guardedUnitTransition(tx, { unitId: unit.id, facilityId: input.facilityId, from: [unit.status], to: "AVAILABLE", data: { quarantineReason: null } });
    await tx.auditEvent.create({ data: { type: "hospital.blood.unitReleased", userId: input.byUserId, detail: { unitId: unit.id, from: unit.status }, facilityId: input.facilityId } });
    return tx.bloodUnit.findUniqueOrThrow({ where: { id: unit.id } });
  });
}

export async function quarantineUnit(input: { unitId: string; facilityId: string; reason: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const unit = await loadUnit(tx, input.unitId, input.facilityId);
    if (!isUnitTransitionAllowed(unit.status, "QUARANTINED")) throw new BloodUnitTransitionError(unit.status, "QUARANTINED");
    await guardedUnitTransition(tx, { unitId: unit.id, facilityId: input.facilityId, from: [unit.status], to: "QUARANTINED", data: { quarantineReason: input.reason } });
    await tx.auditEvent.create({ data: { type: "hospital.blood.unitQuarantined", userId: input.byUserId, detail: { unitId: unit.id, from: unit.status, reason: input.reason }, facilityId: input.facilityId } });
    return tx.bloodUnit.findUniqueOrThrow({ where: { id: unit.id } });
  });
}

/** Recall/quarantine a unit (or every AVAILABLE/RESERVED unit of a lot). Recalled units can never be issued. */
export async function recallUnit(input: { unitId: string; facilityId: string; reason: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const unit = await loadUnit(tx, input.unitId, input.facilityId);
    // Flag recall on any state; additionally pull issuable units into QUARANTINE.
    await tx.bloodUnit.update({ where: { id: unit.id }, data: { recalled: true, recallReason: input.reason } });
    if (unit.status === "AVAILABLE" || unit.status === "RESERVED") {
      await guardedUnitTransition(tx, { unitId: unit.id, facilityId: input.facilityId, from: ["AVAILABLE", "RESERVED"], to: "QUARANTINED", data: { quarantineReason: `Recall: ${input.reason}` } });
      await tx.bloodReservation.updateMany({ where: { unitId: unit.id, status: "ACTIVE" }, data: { status: "RELEASED", releasedAt: new Date(), releasedReason: "Recall" } });
    }
    await tx.auditEvent.create({ data: { type: "hospital.blood.unitRecalled", userId: input.byUserId, detail: { unitId: unit.id, reason: input.reason }, facilityId: input.facilityId } });
    return tx.bloodUnit.findUniqueOrThrow({ where: { id: unit.id } });
  });
}

export async function wasteUnit(input: { unitId: string; facilityId: string; reason: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const unit = await loadUnit(tx, input.unitId, input.facilityId);
    if (!isUnitTransitionAllowed(unit.status, "WASTED")) throw new BloodUnitTransitionError(unit.status, "WASTED");
    await guardedUnitTransition(tx, { unitId: unit.id, facilityId: input.facilityId, from: [unit.status], to: "WASTED", data: { quarantineReason: input.reason } });
    // Free any active reservation — the unit is gone.
    await tx.bloodReservation.updateMany({ where: { unitId: unit.id, status: "ACTIVE" }, data: { status: "RELEASED", releasedAt: new Date(), releasedReason: "Wasted" } });
    await tx.auditEvent.create({ data: { type: "hospital.blood.unitWasted", userId: input.byUserId, detail: { unitId: unit.id, from: unit.status, reason: input.reason }, facilityId: input.facilityId } });
    return tx.bloodUnit.findUniqueOrThrow({ where: { id: unit.id } });
  });
}

// ── Typing (patient + unit) ───────────────────────────────────────────────
export async function recordPatientTyping(input: {
  facilityId: string; patientId: string; encounterId?: string; aboGroup?: AboGroup; rhStatus?: RhStatus; antibodyScreen?: string; specimenRef?: string; performedByStaffId: string; byUserId: string;
}) {
  const patient = await prisma.patient.findUnique({ where: { id: input.patientId } });
  if (!patient || patient.facilityId !== input.facilityId) throw new NotFoundError("Patient not found in this facility.");
  const rec = await prisma.bloodTypingRecord.create({
    data: {
      facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId,
      aboGroup: input.aboGroup, rhStatus: input.rhStatus, antibodyScreen: input.antibodyScreen, specimenRef: input.specimenRef,
      status: input.aboGroup ? "RESULTED" : "PENDING", performedByStaffId: input.performedByStaffId,
    },
  });
  await recordAuditEvent("hospital.blood.typingRecorded", input.byUserId, { typingId: rec.id, scope: "PATIENT" }, { facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId });
  return rec;
}

/** Verify a unit's blood group from an authorized typing record — this is the ONLY path that sets a unit's group to CONFIRMED. */
export async function recordUnitTyping(input: {
  facilityId: string; unitId: string; aboGroup: AboGroup; rhStatus: RhStatus; antibodyScreen?: string; performedByStaffId: string; verifiedByStaffId: string; byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const unit = await loadUnit(tx, input.unitId, input.facilityId);
    const rec = await tx.bloodTypingRecord.create({
      data: {
        facilityId: input.facilityId, unitId: unit.id, aboGroup: input.aboGroup, rhStatus: input.rhStatus,
        antibodyScreen: input.antibodyScreen, status: "VERIFIED", performedByStaffId: input.performedByStaffId,
        verifiedByStaffId: input.verifiedByStaffId, verifiedAt: new Date(),
      },
    });
    await tx.bloodUnit.update({ where: { id: unit.id }, data: { aboGroup: input.aboGroup, rhStatus: input.rhStatus, bloodGroupStatus: "CONFIRMED" } });
    await tx.auditEvent.create({ data: { type: "hospital.blood.typingRecorded", userId: input.byUserId, detail: { typingId: rec.id, scope: "UNIT", unitId: unit.id }, facilityId: input.facilityId } });
    return rec;
  });
}

// ── Blood request lifecycle ───────────────────────────────────────────────
const REQUEST_TRANSITIONS: Record<BloodRequestStatus, BloodRequestStatus[]> = {
  REQUESTED: ["REVIEWED", "CANCELLED", "REJECTED"],
  REVIEWED: ["APPROVED", "CANCELLED", "REJECTED"],
  APPROVED: ["COMPATIBILITY_PENDING", "READY", "CANCELLED"],
  COMPATIBILITY_PENDING: ["READY", "CANCELLED", "REJECTED"],
  READY: ["ISSUED", "CANCELLED"],
  ISSUED: ["COMPLETED", "READY"], // READY again if an issued unit is returned before transfusion
  COMPLETED: [],
  CANCELLED: [],
  REJECTED: [],
};

export class BloodRequestTransitionError extends BadRequestError {
  constructor(from: string, to: string) {
    super(`Illegal blood-request transition ${from} -> ${to}.`);
  }
}

export async function requestBlood(input: {
  facilityId: string; patientId: string; encounterId: string; productId?: string; productName?: string; quantity?: number;
  priority?: BloodRequestPriority; indication?: string; requiredBy?: Date; surgeryId?: string; requestedByStaffId: string; byUserId: string;
}) {
  const encounter = await prisma.encounter.findUnique({ where: { id: input.encounterId } });
  if (!encounter || encounter.facilityId !== input.facilityId || encounter.patientId !== input.patientId) throw new NotFoundError("Encounter not found for this patient/facility.");
  if (encounter.status === "CLOSED" || encounter.status === "CANCELLED") throw new BadRequestError("Cannot request blood against a closed encounter.");

  let productName = input.productName;
  if (input.productId) {
    const product = await prisma.bloodProduct.findUnique({ where: { id: input.productId } });
    if (!product || product.facilityId !== input.facilityId) throw new NotFoundError("Blood product not found.");
    productName = productName ?? product.name;
  }
  if (!productName) throw new BadRequestError("productId or productName is required.");
  const quantity = input.quantity ?? 1;
  if (quantity <= 0) throw new BadRequestError("Quantity must be positive.");

  const request = await prisma.bloodRequest.create({
    data: {
      facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId, productId: input.productId,
      productName, quantity, priority: input.priority ?? "ROUTINE", indication: input.indication, requiredBy: input.requiredBy,
      surgeryId: input.surgeryId, requestedByStaffId: input.requestedByStaffId,
    },
  });
  await recordAuditEvent("hospital.blood.requestCreated", input.byUserId, { requestId: request.id, productName, quantity, priority: request.priority }, { facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId });
  return request;
}

export async function transitionRequest(input: { requestId: string; facilityId: string; to: BloodRequestStatus; actorStaffId: string; reason?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.bloodRequest.findUnique({ where: { id: input.requestId } });
    if (!request || request.facilityId !== input.facilityId) throw new NotFoundError("Blood request not found.");
    if (!(REQUEST_TRANSITIONS[request.status]?.includes(input.to) ?? false)) throw new BloodRequestTransitionError(request.status, input.to);

    const data: Prisma.BloodRequestUpdateManyMutationInput = { status: input.to };
    if (input.to === "REVIEWED") { data.reviewedByStaffId = input.actorStaffId; data.reviewedAt = new Date(); }
    if (input.to === "APPROVED") { data.approvedByStaffId = input.actorStaffId; data.approvedAt = new Date(); }
    if (input.to === "CANCELLED" || input.to === "REJECTED") { data.cancelledReason = input.reason ?? input.to; data.cancelledAt = new Date(); }

    const result = await tx.bloodRequest.updateMany({ where: { id: request.id, status: request.status }, data });
    if (result.count !== 1) throw new BloodRequestTransitionError(request.status, input.to);

    // Cancelling/rejecting a request frees any units reserved for it.
    if (input.to === "CANCELLED" || input.to === "REJECTED") {
      const reservations = await tx.bloodReservation.findMany({ where: { requestId: request.id, status: "ACTIVE" } });
      for (const r of reservations) {
        await guardedUnitTransition(tx, { unitId: r.unitId, facilityId: input.facilityId, from: ["RESERVED"], to: "AVAILABLE" }).catch(() => undefined);
      }
      await tx.bloodReservation.updateMany({ where: { requestId: request.id, status: "ACTIVE" }, data: { status: "RELEASED", releasedAt: new Date(), releasedReason: input.to } });
    }
    await tx.auditEvent.create({ data: { type: "hospital.blood.requestStatusChanged", userId: input.byUserId, detail: { requestId: request.id, from: request.status, to: input.to }, facilityId: request.facilityId, patientId: request.patientId, encounterId: request.encounterId } });
    return tx.bloodRequest.findUniqueOrThrow({ where: { id: request.id } });
  });
}

/** Explicit, authorized emergency release — records that it happened; never selects a "universal donor" or invents emergency compatibility policy. */
export async function authorizeEmergencyRelease(input: { requestId: string; facilityId: string; reason: string; authorizedByStaffId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.bloodRequest.findUnique({ where: { id: input.requestId } });
    if (!request || request.facilityId !== input.facilityId) throw new NotFoundError("Blood request not found.");
    if (request.status === "COMPLETED" || request.status === "CANCELLED" || request.status === "REJECTED") throw new BadRequestError("Cannot authorize emergency release on a closed request.");
    await tx.bloodRequest.update({ where: { id: request.id }, data: { emergencyRelease: true, emergencyReason: input.reason, emergencyAuthorizedByStaffId: input.authorizedByStaffId, emergencyAuthorizedAt: new Date() } });
    await tx.auditEvent.create({ data: { type: "hospital.blood.emergencyReleaseAuthorized", userId: input.byUserId, detail: { requestId: request.id, reason: input.reason, authorizedByStaffId: input.authorizedByStaffId }, facilityId: request.facilityId, patientId: request.patientId, encounterId: request.encounterId } });
    return tx.bloodRequest.findUniqueOrThrow({ where: { id: request.id } });
  });
}

// ── Compatibility (record + verify; never computed) ───────────────────────
export async function recordCompatibility(input: {
  requestId: string; facilityId: string; unitId?: string; testType?: string; aboResult?: AboGroup; rhResult?: RhStatus;
  antibodyScreen?: string; crossmatchResult?: string; status?: "PENDING" | "IN_PROGRESS" | "COMPATIBLE" | "INCOMPATIBLE" | "CANCELLED"; testedByStaffId: string; notes?: string; byUserId: string;
}) {
  const request = await prisma.bloodRequest.findUnique({ where: { id: input.requestId } });
  if (!request || request.facilityId !== input.facilityId) throw new NotFoundError("Blood request not found.");
  if (input.unitId) {
    const unit = await prisma.bloodUnit.findUnique({ where: { id: input.unitId } });
    if (!unit || unit.facilityId !== input.facilityId) throw new NotFoundError("Blood unit not found in this facility.");
  }
  const test = await prisma.bloodCompatibilityTest.create({
    data: {
      facilityId: input.facilityId, requestId: request.id, patientId: request.patientId, encounterId: request.encounterId,
      unitId: input.unitId, testType: input.testType ?? "CROSSMATCH", aboResult: input.aboResult, rhResult: input.rhResult,
      antibodyScreen: input.antibodyScreen, crossmatchResult: input.crossmatchResult, status: input.status ?? "PENDING",
      testedByStaffId: input.testedByStaffId, notes: input.notes,
    },
  });
  await recordAuditEvent("hospital.blood.compatibilityRecorded", input.byUserId, { testId: test.id, requestId: request.id, unitId: input.unitId, status: test.status }, { facilityId: request.facilityId, patientId: request.patientId, encounterId: request.encounterId });
  return test;
}

export async function verifyCompatibility(input: { testId: string; facilityId: string; verifiedByStaffId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const test = await tx.bloodCompatibilityTest.findUnique({ where: { id: input.testId } });
    if (!test || test.facilityId !== input.facilityId) throw new NotFoundError("Compatibility test not found.");
    if (test.status !== "COMPATIBLE" && test.status !== "INCOMPATIBLE") throw new BadRequestError("Only a COMPATIBLE/INCOMPATIBLE result can be verified.");
    if (test.verifiedByStaffId) throw new BadRequestError("Compatibility result is already verified.");
    const updated = await tx.bloodCompatibilityTest.update({ where: { id: test.id }, data: { verifiedByStaffId: input.verifiedByStaffId, verifiedAt: new Date() } });
    await tx.auditEvent.create({ data: { type: "hospital.blood.compatibilityVerified", userId: input.byUserId, detail: { testId: test.id, requestId: test.requestId, status: test.status }, facilityId: test.facilityId, patientId: test.patientId, encounterId: test.encounterId } });
    return updated;
  });
}

// ── Reservation (multi-unit, all-or-none, concurrency-safe) ────────────────
export async function reserveUnits(input: { requestId: string; facilityId: string; unitIds: string[]; reservedByStaffId: string; expiresAt?: Date; byUserId: string }) {
  if (input.unitIds.length === 0) throw new BadRequestError("At least one unit is required.");
  const uniqueIds = [...new Set(input.unitIds)];
  return prisma.$transaction(async (tx) => {
    const request = await tx.bloodRequest.findUnique({ where: { id: input.requestId } });
    if (!request || request.facilityId !== input.facilityId) throw new NotFoundError("Blood request not found.");
    if (request.status === "CANCELLED" || request.status === "REJECTED" || request.status === "COMPLETED") throw new BadRequestError("Cannot reserve units for a closed request.");

    const reservations = [];
    for (const unitId of uniqueIds) {
      const unit = await loadUnit(tx, unitId, input.facilityId);
      assertUnitIssuable(unit);
      // AVAILABLE -> RESERVED, guarded. If any unit is lost to a concurrent
      // reservation, the whole transaction rolls back → all-or-none.
      await guardedUnitTransition(tx, { unitId, facilityId: input.facilityId, from: ["AVAILABLE"], to: "RESERVED" });
      const reservation = await tx.bloodReservation.create({
        data: { facilityId: input.facilityId, unitId, requestId: request.id, patientId: request.patientId, encounterId: request.encounterId, reservedByStaffId: input.reservedByStaffId, expiresAt: input.expiresAt },
      });
      reservations.push(reservation);
    }
    await tx.auditEvent.create({ data: { type: "hospital.blood.unitsReserved", userId: input.byUserId, detail: { requestId: request.id, unitIds: uniqueIds }, facilityId: request.facilityId, patientId: request.patientId, encounterId: request.encounterId } });
    return reservations;
  });
}

export async function releaseReservation(input: { reservationId: string; facilityId: string; reason?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const reservation = await tx.bloodReservation.findUnique({ where: { id: input.reservationId } });
    if (!reservation || reservation.facilityId !== input.facilityId) throw new NotFoundError("Reservation not found.");
    const result = await tx.bloodReservation.updateMany({ where: { id: reservation.id, status: "ACTIVE" }, data: { status: "RELEASED", releasedAt: new Date(), releasedReason: input.reason ?? "Released" } });
    if (result.count !== 1) throw new BadRequestError("Reservation is not active.");
    // Only return the unit to AVAILABLE if it is still RESERVED (not already issued).
    await guardedUnitTransition(tx, { unitId: reservation.unitId, facilityId: input.facilityId, from: ["RESERVED"], to: "AVAILABLE" }).catch(() => undefined);
    await tx.auditEvent.create({ data: { type: "hospital.blood.reservationReleased", userId: input.byUserId, detail: { reservationId: reservation.id, unitId: reservation.unitId }, facilityId: input.facilityId, patientId: reservation.patientId, encounterId: reservation.encounterId } });
    return tx.bloodReservation.findUniqueOrThrow({ where: { id: reservation.id } });
  });
}

// ── Issue (concurrency-safe; compatibility- or emergency-gated) ────────────
export async function issueUnit(input: { requestId: string; facilityId: string; unitId: string; compatibilityTestId?: string; issuedByStaffId: string; issueLocation?: string; recipientLocation?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.bloodRequest.findUnique({ where: { id: input.requestId } });
    if (!request || request.facilityId !== input.facilityId) throw new NotFoundError("Blood request not found.");
    if (request.status === "CANCELLED" || request.status === "REJECTED" || request.status === "COMPLETED") throw new BadRequestError("Cannot issue against a closed request.");

    const unit = await loadUnit(tx, input.unitId, input.facilityId);
    assertUnitIssuable(unit);

    // Compatibility gate: a verified COMPATIBLE result for this unit+request,
    // OR an explicitly authorized emergency release. Never ABO-equality logic.
    if (!request.emergencyRelease) {
      const compatible = await tx.bloodCompatibilityTest.findFirst({
        where: { requestId: request.id, unitId: input.unitId, status: "COMPATIBLE", verifiedByStaffId: { not: null } },
      });
      if (!compatible) throw new BadRequestError("Unit cannot be issued: no verified COMPATIBLE crossmatch for this unit (or authorize an emergency release).");
      if (input.compatibilityTestId && input.compatibilityTestId !== compatible.id) throw new BadRequestError("Provided compatibility test does not match the verified result.");
    }

    // AVAILABLE or RESERVED -> ISSUED, guarded (single-winner double-issue barrier).
    await guardedUnitTransition(tx, { unitId: unit.id, facilityId: input.facilityId, from: ["AVAILABLE", "RESERVED"], to: "ISSUED" });
    await tx.bloodReservation.updateMany({ where: { unitId: unit.id, status: "ACTIVE" }, data: { status: "CONSUMED" } });

    const issue = await tx.bloodIssue.create({
      data: {
        facilityId: input.facilityId, unitId: unit.id, requestId: request.id, patientId: request.patientId, encounterId: request.encounterId,
        compatibilityTestId: input.compatibilityTestId, emergencyRelease: request.emergencyRelease, issuedByStaffId: input.issuedByStaffId,
        issueLocation: input.issueLocation, recipientLocation: input.recipientLocation,
      },
    });
    if (request.status !== "ISSUED") await tx.bloodRequest.updateMany({ where: { id: request.id, status: request.status }, data: { status: "ISSUED" } });
    await tx.auditEvent.create({ data: { type: "hospital.blood.unitIssued", userId: input.byUserId, detail: { issueId: issue.id, unitId: unit.id, requestId: request.id, emergencyRelease: request.emergencyRelease }, facilityId: request.facilityId, patientId: request.patientId, encounterId: request.encounterId } });
    return issue;
  });
}

// ── Transport / receipt ───────────────────────────────────────────────────
export async function dispatchIssue(input: { issueId: string; facilityId: string; dispatchedByStaffId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const issue = await tx.bloodIssue.findUnique({ where: { id: input.issueId } });
    if (!issue || issue.facilityId !== input.facilityId) throw new NotFoundError("Issue record not found.");
    const result = await tx.bloodIssue.updateMany({ where: { id: issue.id, status: "ISSUED" }, data: { status: "IN_TRANSIT", dispatchedByStaffId: input.dispatchedByStaffId, dispatchedAt: new Date() } });
    if (result.count !== 1) throw new BadRequestError("Issue is not in an ISSUED state.");
    await guardedUnitTransition(tx, { unitId: issue.unitId, facilityId: input.facilityId, from: ["ISSUED"], to: "IN_TRANSIT" }).catch(() => undefined);
    await tx.auditEvent.create({ data: { type: "hospital.blood.unitDispatched", userId: input.byUserId, detail: { issueId: issue.id, unitId: issue.unitId }, facilityId: issue.facilityId, patientId: issue.patientId, encounterId: issue.encounterId } });
    return tx.bloodIssue.findUniqueOrThrow({ where: { id: issue.id } });
  });
}

export async function receiveIssue(input: { issueId: string; facilityId: string; receivedByStaffId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const issue = await tx.bloodIssue.findUnique({ where: { id: input.issueId } });
    if (!issue || issue.facilityId !== input.facilityId) throw new NotFoundError("Issue record not found.");
    const result = await tx.bloodIssue.updateMany({ where: { id: issue.id, status: { in: ["ISSUED", "IN_TRANSIT"] } }, data: { status: "RECEIVED", receivedByStaffId: input.receivedByStaffId, receivedAt: new Date() } });
    if (result.count !== 1) throw new BadRequestError("Issue cannot be received in its current state.");
    await guardedUnitTransition(tx, { unitId: issue.unitId, facilityId: input.facilityId, from: ["IN_TRANSIT"], to: "ISSUED" }).catch(() => undefined);
    await tx.auditEvent.create({ data: { type: "hospital.blood.unitReceived", userId: input.byUserId, detail: { issueId: issue.id, unitId: issue.unitId }, facilityId: issue.facilityId, patientId: issue.patientId, encounterId: issue.encounterId } });
    return tx.bloodIssue.findUniqueOrThrow({ where: { id: issue.id } });
  });
}

/** Return an issued-but-unused unit. Sets RETURNED (never auto-AVAILABLE — that requires an explicit release after inspection). */
export async function returnUnit(input: { issueId: string; facilityId: string; reason: string; receivedByStaffId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const issue = await tx.bloodIssue.findUnique({ where: { id: input.issueId } });
    if (!issue || issue.facilityId !== input.facilityId) throw new NotFoundError("Issue record not found.");
    // Guarded: the unit must still be issued/in-transit (not transfusing) — this
    // is also the return-vs-transfusion race barrier.
    await guardedUnitTransition(tx, { unitId: issue.unitId, facilityId: input.facilityId, from: ["ISSUED", "IN_TRANSIT"], to: "RETURNED", data: { quarantineReason: input.reason } });
    await tx.bloodIssue.updateMany({ where: { id: issue.id, status: { in: ["ISSUED", "IN_TRANSIT", "RECEIVED"] } }, data: { status: "RETURNED", returnedReason: input.reason, returnedAt: new Date(), receivedByStaffId: input.receivedByStaffId } });
    await tx.auditEvent.create({ data: { type: "hospital.blood.unitReturned", userId: input.byUserId, detail: { issueId: issue.id, unitId: issue.unitId, reason: input.reason }, facilityId: issue.facilityId, patientId: issue.patientId, encounterId: issue.encounterId } });
    return tx.bloodIssue.findUniqueOrThrow({ where: { id: issue.id } });
  });
}

// ── Transfusion (bedside) ─────────────────────────────────────────────────
export async function startTransfusion(input: {
  requestId: string; facilityId: string; unitId: string; administeredByStaffId: string;
  patientIdentityVerified: boolean; unitIdentityVerified: boolean; productVerified: boolean; bloodGroupReviewed: boolean; compatibilityReviewed: boolean; expiryReviewed: boolean; secondCheckStaffId?: string; byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.bloodRequest.findUnique({ where: { id: input.requestId } });
    if (!request || request.facilityId !== input.facilityId) throw new NotFoundError("Blood request not found.");
    const unit = await loadUnit(tx, input.unitId, input.facilityId);
    if (unit.recalled) throw new BadRequestError("A recalled unit must not be transfused.");
    if (unit.expiresAt && unit.expiresAt.getTime() <= Date.now()) throw new BadRequestError("An expired unit must not be transfused.");
    // Bedside verification is required to start (documentation support, not a
    // replacement for institutional policy).
    if (!(input.patientIdentityVerified && input.unitIdentityVerified && input.productVerified && input.bloodGroupReviewed && input.compatibilityReviewed && input.expiryReviewed)) {
      throw new BadRequestError("All bedside verification checks must be confirmed before starting a transfusion.");
    }
    // ISSUED -> TRANSFUSING, guarded (single-winner; also the transfusion-start
    // side of the return-vs-transfusion and waste/issue races).
    await guardedUnitTransition(tx, { unitId: unit.id, facilityId: input.facilityId, from: ["ISSUED"], to: "TRANSFUSING" });
    const transfusion = await tx.transfusion.create({
      data: {
        facilityId: input.facilityId, requestId: request.id, unitId: unit.id, patientId: request.patientId, encounterId: request.encounterId,
        productName: request.productName, status: "IN_PROGRESS", administeredByStaffId: input.administeredByStaffId,
        patientIdentityVerified: true, unitIdentityVerified: true, productVerified: true, bloodGroupReviewed: true, compatibilityReviewed: true, expiryReviewed: true,
        secondCheckStaffId: input.secondCheckStaffId, verifiedAt: new Date(), startedAt: new Date(),
      },
    });
    await tx.auditEvent.create({ data: { type: "hospital.blood.transfusionStarted", userId: input.byUserId, detail: { transfusionId: transfusion.id, unitId: unit.id, requestId: request.id }, facilityId: request.facilityId, patientId: request.patientId, encounterId: request.encounterId } });
    return transfusion;
  });
}

export async function recordTransfusionObservation(input: { transfusionId: string; facilityId: string; observationType: string; value: string; recordedByStaffId: string; byUserId: string }) {
  const transfusion = await prisma.transfusion.findUnique({ where: { id: input.transfusionId } });
  if (!transfusion || transfusion.facilityId !== input.facilityId) throw new NotFoundError("Transfusion not found.");
  const obs = await prisma.transfusionObservation.create({
    data: { transfusionId: transfusion.id, observationType: input.observationType, value: input.value, recordedByStaffId: input.recordedByStaffId },
  });
  await recordAuditEvent("hospital.blood.transfusionObservationRecorded", input.byUserId, { transfusionId: transfusion.id, observationId: obs.id, observationType: input.observationType }, { facilityId: transfusion.facilityId, patientId: transfusion.patientId, encounterId: transfusion.encounterId });
  return obs;
}

const TRANSFUSION_TRANSITIONS: Record<string, string[]> = {
  RECEIVED: ["IN_PROGRESS", "STOPPED"],
  IN_PROGRESS: ["PAUSED", "COMPLETED", "STOPPED"],
  PAUSED: ["IN_PROGRESS", "COMPLETED", "STOPPED"],
  COMPLETED: [],
  STOPPED: [],
};

/** Guarded transfusion lifecycle transition (pause/resume/complete/stop). Concurrency-safe via status precondition — single-winner completion race. */
export async function transitionTransfusion(input: { transfusionId: string; facilityId: string; to: "IN_PROGRESS" | "PAUSED" | "COMPLETED" | "STOPPED"; reason?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const transfusion = await tx.transfusion.findUnique({ where: { id: input.transfusionId } });
    if (!transfusion || transfusion.facilityId !== input.facilityId) throw new NotFoundError("Transfusion not found.");
    if (!(TRANSFUSION_TRANSITIONS[transfusion.status]?.includes(input.to) ?? false)) throw new BadRequestError(`Illegal transfusion transition ${transfusion.status} -> ${input.to}.`);

    const data: Prisma.TransfusionUpdateManyMutationInput = { status: input.to };
    if (input.to === "PAUSED") data.pausedAt = new Date();
    if (input.to === "COMPLETED" || input.to === "STOPPED") { data.endedAt = new Date(); if (input.reason) data.stoppedReason = input.reason; }

    const result = await tx.transfusion.updateMany({ where: { id: transfusion.id, status: transfusion.status }, data });
    if (result.count !== 1) throw new BadRequestError("Transfusion changed state concurrently — refresh and try again.");

    // On completion the unit is spent (TRANSFUSED). On stop, leave it TRANSFUSING
    // for explicit disposition (quarantine/waste) — never silently reusable.
    if (input.to === "COMPLETED") {
      await guardedUnitTransition(tx, { unitId: transfusion.unitId, facilityId: input.facilityId, from: ["TRANSFUSING"], to: "TRANSFUSED" }).catch(() => undefined);
      await tx.bloodRequest.updateMany({ where: { id: transfusion.requestId, status: "ISSUED" }, data: { status: "COMPLETED" } });
    }
    await tx.auditEvent.create({ data: { type: input.to === "COMPLETED" ? "hospital.blood.transfusionCompleted" : "hospital.blood.transfusionStatusChanged", userId: input.byUserId, detail: { transfusionId: transfusion.id, from: transfusion.status, to: input.to }, facilityId: transfusion.facilityId, patientId: transfusion.patientId, encounterId: transfusion.encounterId } });
    return tx.transfusion.findUniqueOrThrow({ where: { id: transfusion.id } });
  });
}

// ── Reaction / incident ───────────────────────────────────────────────────
export async function reportReaction(input: { transfusionId: string; facilityId: string; reportedByStaffId: string; symptoms?: string; actionTaken?: string; notes?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const transfusion = await tx.transfusion.findUnique({ where: { id: input.transfusionId } });
    if (!transfusion || transfusion.facilityId !== input.facilityId) throw new NotFoundError("Transfusion not found.");
    const reaction = await tx.transfusionReaction.create({
      data: {
        facilityId: input.facilityId, transfusionId: transfusion.id, unitId: transfusion.unitId, patientId: transfusion.patientId, encounterId: transfusion.encounterId,
        reportedByStaffId: input.reportedByStaffId, symptoms: input.symptoms, actionTaken: input.actionTaken, notes: input.notes,
      },
    });
    // Reporting a reaction quarantines the unit for investigation — it must NOT
    // return to available inventory. Guarded from any non-terminal state.
    const unit = await loadUnit(tx, transfusion.unitId, input.facilityId);
    if (isUnitTransitionAllowed(unit.status, "QUARANTINED")) {
      await guardedUnitTransition(tx, { unitId: unit.id, facilityId: input.facilityId, from: [unit.status], to: "QUARANTINED", data: { quarantineReason: "Transfusion reaction under investigation" } }).catch(() => undefined);
    }
    await tx.auditEvent.create({ data: { type: "hospital.blood.reactionReported", userId: input.byUserId, detail: { reactionId: reaction.id, transfusionId: transfusion.id, unitId: transfusion.unitId }, facilityId: transfusion.facilityId, patientId: transfusion.patientId, encounterId: transfusion.encounterId } });
    return reaction;
  });
}

const REACTION_TRANSITIONS: Record<string, string[]> = {
  REPORTED: ["UNDER_REVIEW", "ESCALATED", "RESOLVED"],
  UNDER_REVIEW: ["ESCALATED", "RESOLVED"],
  ESCALATED: ["RESOLVED"],
  RESOLVED: [],
};

export async function transitionReaction(input: { reactionId: string; facilityId: string; to: "UNDER_REVIEW" | "ESCALATED" | "RESOLVED"; actorStaffId: string; escalationRef?: string; notes?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const reaction = await tx.transfusionReaction.findUnique({ where: { id: input.reactionId } });
    if (!reaction || reaction.facilityId !== input.facilityId) throw new NotFoundError("Reaction not found.");
    if (!(REACTION_TRANSITIONS[reaction.status]?.includes(input.to) ?? false)) throw new BadRequestError(`Illegal reaction transition ${reaction.status} -> ${input.to}.`);
    const data: Prisma.TransfusionReactionUpdateManyMutationInput = { status: input.to };
    if (input.to === "ESCALATED" && input.escalationRef) data.escalationRef = input.escalationRef;
    if (input.to === "RESOLVED") { data.resolvedByStaffId = input.actorStaffId; data.resolvedAt = new Date(); }
    if (input.notes !== undefined) data.notes = input.notes;
    const result = await tx.transfusionReaction.updateMany({ where: { id: reaction.id, status: reaction.status }, data });
    if (result.count !== 1) throw new BadRequestError("Reaction changed state concurrently — refresh and try again.");
    await tx.auditEvent.create({ data: { type: "hospital.blood.reactionStatusChanged", userId: input.byUserId, detail: { reactionId: reaction.id, from: reaction.status, to: input.to }, facilityId: reaction.facilityId, patientId: reaction.patientId, encounterId: reaction.encounterId } });
    return tx.transfusionReaction.findUniqueOrThrow({ where: { id: reaction.id } });
  });
}

// ── Composition: dashboard, board, workspace, timeline, traceability ───────
export async function buildBloodBankDashboard(facilityId: string) {
  const [byStatus, expiringUnits, requests, pendingCompat, activeTransfusions, openReactions, recalledUnits] = await Promise.all([
    prisma.bloodUnit.groupBy({ by: ["status"], where: { facilityId }, _count: { _all: true } }),
    prisma.bloodUnit.findMany({ where: { facilityId, status: { in: ["AVAILABLE", "RESERVED"] }, expiresAt: { not: null, lte: new Date(Date.now() + 7 * 24 * 3600_000) } }, include: { product: true }, orderBy: { expiresAt: "asc" }, take: 25 }),
    prisma.bloodRequest.findMany({ where: { facilityId, status: { in: ["REQUESTED", "REVIEWED", "APPROVED", "COMPATIBILITY_PENDING", "READY"] } }, include: { patient: true }, orderBy: [{ priority: "desc" }, { requestedAt: "asc" }], take: 50 }),
    prisma.bloodCompatibilityTest.count({ where: { facilityId, status: { in: ["PENDING", "IN_PROGRESS"] } } }),
    prisma.transfusion.findMany({ where: { facilityId, status: { in: ["IN_PROGRESS", "PAUSED"] } }, include: { unit: true }, orderBy: { startedAt: "desc" }, take: 50 }),
    prisma.transfusionReaction.findMany({ where: { facilityId, status: { in: ["REPORTED", "UNDER_REVIEW", "ESCALATED"] } }, orderBy: { reportedAt: "desc" }, take: 25 }),
    prisma.bloodUnit.count({ where: { facilityId, recalled: true } }),
  ]);
  const inventory = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all]));
  return { inventory, expiringUnits, requests, pendingCompatibility: pendingCompat, activeTransfusions, openReactions, recalledUnits };
}

export async function buildBloodRequestBoard(facilityId: string) {
  const requests = await prisma.bloodRequest.findMany({
    where: { facilityId, status: { notIn: ["COMPLETED", "CANCELLED", "REJECTED"] } },
    include: { patient: true, reservations: { where: { status: "ACTIVE" } }, compatibilityTests: true },
    orderBy: [{ priority: "desc" }, { requestedAt: "asc" }], take: 100,
  });
  return requests.map((r) => ({
    id: r.id, patient: { id: r.patient.id, fullName: r.patient.fullName, uhid: r.patient.uhid }, encounterId: r.encounterId,
    productName: r.productName, quantity: r.quantity, priority: r.priority, status: r.status,
    compatibility: r.compatibilityTests.some((t) => t.status === "COMPATIBLE" && t.verifiedByStaffId) ? "VERIFIED_COMPATIBLE" : r.compatibilityTests.some((t) => t.status === "INCOMPATIBLE") ? "INCOMPATIBLE" : r.compatibilityTests.length ? "PENDING" : "NONE",
    reservedUnits: r.reservations.length, emergencyRelease: r.emergencyRelease, requestedByStaffId: r.requestedByStaffId, requestedAt: r.requestedAt,
  }));
}

export async function getTransfusionWorkspace(requestId: string) {
  const request = await prisma.bloodRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: {
      patient: true, product: true,
      compatibilityTests: { include: { unit: true }, orderBy: { createdAt: "desc" } },
      reservations: { include: { unit: true }, orderBy: { createdAt: "desc" } },
      issues: { include: { unit: true }, orderBy: { createdAt: "desc" } },
      transfusions: { include: { unit: true, observations: { orderBy: { recordedAt: "desc" } }, reactions: { orderBy: { reportedAt: "desc" } } }, orderBy: { createdAt: "desc" } },
    },
  });
  const [location, notes] = await Promise.all([
    prisma.encounterLocation.findFirst({ where: { encounterId: request.encounterId, releasedAt: null }, include: { bed: { include: { ward: true } } }, orderBy: { assignedAt: "desc" } }),
    prisma.clinicalNote.findMany({ where: { encounterId: request.encounterId, type: { in: ["TRANSFUSION", "PROGRESS", "PROCEDURE"] } }, include: { author: { include: { user: true } } }, orderBy: { createdAt: "desc" }, take: 8 }),
  ]);
  return { request, location, notes };
}

export interface BloodTimelineEntry { id: string; timestamp: string; type: string; summary: string; sourceType: string; sourceId: string }

export async function buildBloodTimeline(requestId: string): Promise<BloodTimelineEntry[]> {
  const request = await prisma.bloodRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { compatibilityTests: true, reservations: true, issues: true, transfusions: { include: { observations: true, reactions: true } } },
  });
  const e: BloodTimelineEntry[] = [];
  e.push({ id: `req-${request.id}`, timestamp: request.requestedAt.toISOString(), type: "Requested", summary: `Blood requested: ${request.productName} x${request.quantity} (${request.priority})`, sourceType: "BloodRequest", sourceId: request.id });
  if (request.reviewedAt) e.push({ id: `rev-${request.id}`, timestamp: request.reviewedAt.toISOString(), type: "Reviewed", summary: "Request reviewed", sourceType: "BloodRequest", sourceId: request.id });
  if (request.approvedAt) e.push({ id: `app-${request.id}`, timestamp: request.approvedAt.toISOString(), type: "Approved", summary: "Request approved", sourceType: "BloodRequest", sourceId: request.id });
  if (request.emergencyAuthorizedAt) e.push({ id: `emg-${request.id}`, timestamp: request.emergencyAuthorizedAt.toISOString(), type: "EmergencyRelease", summary: `Emergency release authorized: ${request.emergencyReason ?? ""}`, sourceType: "BloodRequest", sourceId: request.id });
  for (const t of request.compatibilityTests) e.push({ id: `compat-${t.id}`, timestamp: (t.verifiedAt ?? t.createdAt).toISOString(), type: "Compatibility", summary: `Compatibility ${t.status}${t.verifiedByStaffId ? " (verified)" : ""}`, sourceType: "BloodCompatibilityTest", sourceId: t.id });
  for (const r of request.reservations) e.push({ id: `resv-${r.id}`, timestamp: r.createdAt.toISOString(), type: "Reserved", summary: `Unit reserved${r.status !== "ACTIVE" ? ` (${r.status})` : ""}`, sourceType: "BloodReservation", sourceId: r.id });
  for (const i of request.issues) {
    e.push({ id: `iss-${i.id}`, timestamp: i.createdAt.toISOString(), type: "Issued", summary: `Unit issued${i.emergencyRelease ? " (emergency)" : ""}`, sourceType: "BloodIssue", sourceId: i.id });
    if (i.receivedAt) e.push({ id: `rcv-${i.id}`, timestamp: i.receivedAt.toISOString(), type: "Received", summary: "Unit received at bedside", sourceType: "BloodIssue", sourceId: i.id });
    if (i.returnedAt) e.push({ id: `ret-${i.id}`, timestamp: i.returnedAt.toISOString(), type: "Returned", summary: `Unit returned: ${i.returnedReason ?? ""}`, sourceType: "BloodIssue", sourceId: i.id });
  }
  for (const t of request.transfusions) {
    if (t.startedAt) e.push({ id: `tstart-${t.id}`, timestamp: t.startedAt.toISOString(), type: "TransfusionStart", summary: "Transfusion started", sourceType: "Transfusion", sourceId: t.id });
    for (const o of t.observations) e.push({ id: `obs-${o.id}`, timestamp: o.recordedAt.toISOString(), type: "Observation", summary: `${o.observationType}: ${o.value}`, sourceType: "TransfusionObservation", sourceId: o.id });
    for (const rx of t.reactions) e.push({ id: `rxn-${rx.id}`, timestamp: rx.reportedAt.toISOString(), type: "Reaction", summary: `Reaction reported (${rx.status})`, sourceType: "TransfusionReaction", sourceId: rx.id });
    if (t.endedAt) e.push({ id: `tend-${t.id}`, timestamp: t.endedAt.toISOString(), type: "TransfusionEnd", summary: `Transfusion ${t.status.toLowerCase()}`, sourceType: "Transfusion", sourceId: t.id });
  }
  return e.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Full traceability for a single unit (where is it, who got it, was it transfused, any reaction). */
export async function getUnitTraceability(unitId: string, facilityId: string) {
  const unit = await prisma.bloodUnit.findUnique({
    where: { id: unitId },
    include: { product: true, itemLot: true, location: true, typingRecords: true, reservations: { include: { request: { include: { patient: true } } } }, issues: { include: { request: { include: { patient: true } } } }, transfusions: { include: { reactions: true } }, reactions: true },
  });
  if (!unit || unit.facilityId !== facilityId) throw new NotFoundError("Blood unit not found.");
  return unit;
}

/** Patient blood history (requested/reserved/issued/transfused/returned/wasted/reactions). */
export async function getPatientBloodHistory(patientId: string, facilityId: string) {
  const patient = await prisma.patient.findUnique({ where: { id: patientId } });
  if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");
  const [requests, transfusions, reactions] = await Promise.all([
    prisma.bloodRequest.findMany({ where: { facilityId, patientId }, include: { issues: true, reservations: true }, orderBy: { requestedAt: "desc" }, take: 100 }),
    prisma.transfusion.findMany({ where: { facilityId, patientId }, include: { unit: true }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.transfusionReaction.findMany({ where: { facilityId, patientId }, orderBy: { reportedAt: "desc" }, take: 50 }),
  ]);
  return { requests, transfusions, reactions };
}
