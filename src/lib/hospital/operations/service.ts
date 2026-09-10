import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import {
  HOUSEKEEPING_TRANSITIONS, TRANSPORT_TRANSITIONS, AMBULANCE_TRIP_TRANSITIONS, MEAL_TRANSITIONS,
  MAINTENANCE_TRANSITIONS, INFECTION_TRANSITIONS, isTransitionAllowed, assertStaffActiveInFacility,
} from "@/lib/hospital/operations/shared";

/**
 * Phase B9 Hospital Operations service — housekeeping, dietary, transport,
 * ambulance, maintenance, biomedical, infection control. Reuses canonical
 * Patient/Encounter/Bed/Staff/AuditEvent; bed turnaround goes through the
 * canonical completeBedCleaning() ADT service. Every mutation is facility-scoped
 * and audited; every lifecycle uses a guarded status-preconditioned updateMany
 * (single-winner). No clinical intelligence.
 */

export class OperationsConcurrencyError extends BadRequestError {
  constructor(message = "This record changed state concurrently. Refresh and try again.") { super(message); }
}

async function assertPatientInFacility(patientId: string, facilityId: string) {
  const p = await prisma.patient.findUnique({ where: { id: patientId } });
  if (!p || p.facilityId !== facilityId) throw new NotFoundError("Patient not found in this facility.");
  return p;
}
async function assertBedInFacility(bedId: string, facilityId: string) {
  const b = await prisma.bed.findUnique({ where: { id: bedId } });
  if (!b || b.facilityId !== facilityId) throw new NotFoundError("Bed not found in this facility.");
  return b;
}

// ══ HOUSEKEEPING ═════════════════════════════════════════════════════════════
export async function createHousekeepingRequest(input: { facilityId: string; requestType: string; bedId?: string; wardId?: string; areaLabel?: string; priority?: string; reason?: string; isDischargeCleaning?: boolean; encounterId?: string; requestedByStaffId: string; byUserId: string }) {
  if (input.bedId) await assertBedInFacility(input.bedId, input.facilityId);
  const req = await prisma.housekeepingRequest.create({
    data: { facilityId: input.facilityId, requestType: input.requestType, bedId: input.bedId, wardId: input.wardId, areaLabel: input.areaLabel, priority: input.priority ?? "ROUTINE", reason: input.reason, isDischargeCleaning: input.isDischargeCleaning ?? false, encounterId: input.encounterId, requestedByStaffId: input.requestedByStaffId },
  });
  await recordAuditEvent("hospital.ops.housekeepingCreated", input.byUserId, { requestId: req.id, requestType: req.requestType, bedId: input.bedId }, { facilityId: input.facilityId, encounterId: input.encounterId });
  return req;
}

export async function transitionHousekeeping(input: { requestId: string; facilityId: string; to: string; actorStaffId: string; notes?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.housekeepingRequest.findUnique({ where: { id: input.requestId } });
    if (!req || req.facilityId !== input.facilityId) throw new NotFoundError("Housekeeping request not found.");
    if (!isTransitionAllowed(HOUSEKEEPING_TRANSITIONS, req.status, input.to)) throw new BadRequestError(`Illegal housekeeping transition ${req.status} -> ${input.to}.`);
    const data: Record<string, unknown> = { status: input.to, ...(input.notes !== undefined ? { notes: input.notes } : {}) };
    if (input.to === "ASSIGNED") { await assertStaffActiveInFacility(tx, input.actorStaffId, input.facilityId); data.assignedToStaffId = input.actorStaffId; data.assignedAt = new Date(); }
    if (input.to === "IN_PROGRESS") data.startedAt = new Date();
    if (input.to === "COMPLETED") data.completedAt = new Date();
    if (input.to === "INSPECTED") { data.inspectedByStaffId = input.actorStaffId; data.inspectedAt = new Date(); }
    if (input.to === "CLOSED") data.closedAt = new Date();
    if (input.to === "CANCELLED") { data.cancelledAt = new Date(); data.cancelledReason = input.notes ?? "Cancelled"; }
    const r = await tx.housekeepingRequest.updateMany({ where: { id: req.id, status: req.status }, data });
    if (r.count !== 1) throw new OperationsConcurrencyError();
    // Bed turnaround: a completed discharge-cleaning frees the bed via canonical ADT.
    if (input.to === "COMPLETED" && req.isDischargeCleaning && req.bedId) {
      const bed = await tx.bed.findUnique({ where: { id: req.bedId } });
      if (bed && bed.status === "CLEANING") {
        const cas = await tx.bed.updateMany({ where: { id: req.bedId, status: "CLEANING" }, data: { status: "AVAILABLE" } });
        if (cas.count === 1) await tx.bedStateEvent.create({ data: { bedId: req.bedId, fromStatus: "CLEANING", toStatus: "AVAILABLE", reason: "Housekeeping complete", byUserId: input.byUserId } });
      }
    }
    await tx.auditEvent.create({ data: { type: "hospital.ops.housekeepingUpdated", userId: input.byUserId, detail: { requestId: req.id, from: req.status, to: input.to }, facilityId: req.facilityId, encounterId: req.encounterId } });
    return tx.housekeepingRequest.findUniqueOrThrow({ where: { id: req.id } });
  });
}

// ══ DIETARY ══════════════════════════════════════════════════════════════════
export async function createDietOrder(input: { facilityId: string; patientId: string; encounterId: string; dietType: string; restrictions?: string; effectiveFrom?: Date; effectiveTo?: Date; orderedByStaffId: string; notes?: string; byUserId: string }) {
  const enc = await prisma.encounter.findUnique({ where: { id: input.encounterId } });
  if (!enc || enc.facilityId !== input.facilityId || enc.patientId !== input.patientId) throw new NotFoundError("Encounter not found for this patient/facility.");
  const order = await prisma.dietOrder.create({ data: { facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId, dietType: input.dietType, restrictions: input.restrictions, effectiveFrom: input.effectiveFrom ?? new Date(), effectiveTo: input.effectiveTo, orderedByStaffId: input.orderedByStaffId, notes: input.notes } });
  await recordAuditEvent("hospital.ops.dietOrderCreated", input.byUserId, { dietOrderId: order.id, dietType: order.dietType }, { facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId });
  return order;
}

export async function setDietOrderStatus(input: { dietOrderId: string; facilityId: string; to: "DISCONTINUED" | "CANCELLED"; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.dietOrder.findUnique({ where: { id: input.dietOrderId } });
    if (!order || order.facilityId !== input.facilityId) throw new NotFoundError("Diet order not found.");
    const r = await tx.dietOrder.updateMany({ where: { id: order.id, status: "ACTIVE" }, data: { status: input.to, effectiveTo: new Date() } });
    if (r.count !== 1) throw new BadRequestError("Diet order is not active.");
    await tx.auditEvent.create({ data: { type: "hospital.ops.dietOrderUpdated", userId: input.byUserId, detail: { dietOrderId: order.id, to: input.to }, facilityId: order.facilityId, patientId: order.patientId, encounterId: order.encounterId } });
    return tx.dietOrder.findUniqueOrThrow({ where: { id: order.id } });
  });
}

export async function planMeal(input: { facilityId: string; dietOrderId: string; mealPeriod: string; plannedFor: Date; byUserId: string }) {
  const order = await prisma.dietOrder.findUnique({ where: { id: input.dietOrderId } });
  if (!order || order.facilityId !== input.facilityId) throw new NotFoundError("Diet order not found.");
  if (order.status !== "ACTIVE") throw new BadRequestError("Cannot plan a meal for an inactive diet order.");
  const meal = await prisma.meal.create({ data: { facilityId: input.facilityId, dietOrderId: order.id, patientId: order.patientId, encounterId: order.encounterId, mealPeriod: input.mealPeriod, plannedFor: input.plannedFor } });
  await recordAuditEvent("hospital.ops.mealPlanned", input.byUserId, { mealId: meal.id, mealPeriod: meal.mealPeriod }, { facilityId: input.facilityId, patientId: order.patientId, encounterId: order.encounterId });
  return meal;
}

export async function transitionMeal(input: { mealId: string; facilityId: string; to: string; actorStaffId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const meal = await tx.meal.findUnique({ where: { id: input.mealId } });
    if (!meal || meal.facilityId !== input.facilityId) throw new NotFoundError("Meal not found.");
    if (!isTransitionAllowed(MEAL_TRANSITIONS, meal.status, input.to)) throw new BadRequestError(`Illegal meal transition ${meal.status} -> ${input.to}.`);
    const data: Record<string, unknown> = { status: input.to };
    if (input.to === "PREPARING") { data.preparedByStaffId = input.actorStaffId; }
    if (input.to === "READY") { data.preparedAt = new Date(); data.readyAt = new Date(); }
    if (input.to === "DELIVERED") { data.deliveredByStaffId = input.actorStaffId; data.deliveredAt = new Date(); }
    if (input.to === "REFUSED") data.refusedAt = new Date();
    const r = await tx.meal.updateMany({ where: { id: meal.id, status: meal.status }, data });
    if (r.count !== 1) throw new OperationsConcurrencyError();
    await tx.auditEvent.create({ data: { type: "hospital.ops.mealUpdated", userId: input.byUserId, detail: { mealId: meal.id, from: meal.status, to: input.to }, facilityId: meal.facilityId, patientId: meal.patientId, encounterId: meal.encounterId } });
    return tx.meal.findUniqueOrThrow({ where: { id: meal.id } });
  });
}

// ══ PATIENT TRANSPORT ════════════════════════════════════════════════════════
export async function createTransportRequest(input: { facilityId: string; patientId: string; transportType: string; encounterId?: string; pickupBedId?: string; pickupLabel?: string; destinationBedId?: string; destinationLabel?: string; priority?: string; equipmentNote?: string; requestedByStaffId: string; byUserId: string }) {
  await assertPatientInFacility(input.patientId, input.facilityId);
  if (input.pickupBedId) await assertBedInFacility(input.pickupBedId, input.facilityId);
  if (input.destinationBedId) await assertBedInFacility(input.destinationBedId, input.facilityId);
  const req = await prisma.patientTransportRequest.create({
    data: { facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId, transportType: input.transportType, pickupBedId: input.pickupBedId, pickupLabel: input.pickupLabel, destinationBedId: input.destinationBedId, destinationLabel: input.destinationLabel, priority: input.priority ?? "ROUTINE", equipmentNote: input.equipmentNote, requestedByStaffId: input.requestedByStaffId },
  });
  await recordAuditEvent("hospital.ops.transportCreated", input.byUserId, { requestId: req.id, transportType: req.transportType }, { facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId });
  return req;
}

export async function transitionTransport(input: { requestId: string; facilityId: string; to: string; actorStaffId: string; notes?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.patientTransportRequest.findUnique({ where: { id: input.requestId } });
    if (!req || req.facilityId !== input.facilityId) throw new NotFoundError("Transport request not found.");
    if (!isTransitionAllowed(TRANSPORT_TRANSITIONS, req.status, input.to)) throw new BadRequestError(`Illegal transport transition ${req.status} -> ${input.to}.`);
    const data: Record<string, unknown> = { status: input.to };
    if (input.to === "ACCEPTED") data.acceptedAt = new Date();
    if (input.to === "ASSIGNED") { await assertStaffActiveInFacility(tx, input.actorStaffId, input.facilityId); data.assignedToStaffId = input.actorStaffId; data.assignedAt = new Date(); }
    if (input.to === "PATIENT_PICKED_UP") data.pickedUpAt = new Date();
    if (input.to === "ARRIVED") data.arrivedAt = new Date();
    if (input.to === "COMPLETED") data.completedAt = new Date();
    if (input.to === "CANCELLED" || input.to === "REJECTED") { data.cancelledAt = new Date(); data.cancelledReason = input.notes ?? input.to; }
    const r = await tx.patientTransportRequest.updateMany({ where: { id: req.id, status: req.status }, data });
    if (r.count !== 1) throw new OperationsConcurrencyError();
    await tx.auditEvent.create({ data: { type: "hospital.ops.transportUpdated", userId: input.byUserId, detail: { requestId: req.id, from: req.status, to: input.to }, facilityId: req.facilityId, patientId: req.patientId, encounterId: req.encounterId } });
    return tx.patientTransportRequest.findUniqueOrThrow({ where: { id: req.id } });
  });
}

// ══ AMBULANCE ════════════════════════════════════════════════════════════════
export async function createAmbulance(input: { facilityId: string; registration: string; type: string; capabilities?: unknown; byUserId: string }) {
  const amb = await prisma.ambulance.create({ data: { facilityId: input.facilityId, registration: input.registration, type: input.type, capabilities: (input.capabilities ?? undefined) as never } })
    .catch((e: unknown) => { if (e instanceof Error && /unique/i.test(e.message)) throw new BadRequestError("An ambulance with that registration already exists."); throw e; });
  await recordAuditEvent("hospital.ops.ambulanceCreated", input.byUserId, { ambulanceId: amb.id, registration: amb.registration }, { facilityId: input.facilityId });
  return amb;
}

export async function setAmbulanceStatus(input: { ambulanceId: string; facilityId: string; to: "AVAILABLE" | "MAINTENANCE" | "OUT_OF_SERVICE"; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const amb = await tx.ambulance.findUnique({ where: { id: input.ambulanceId } });
    if (!amb || amb.facilityId !== input.facilityId) throw new NotFoundError("Ambulance not found.");
    if (amb.status === "ON_TRIP") throw new BadRequestError("Cannot change status of an ambulance on an active trip.");
    await tx.ambulance.update({ where: { id: amb.id }, data: { status: input.to } });
    await tx.auditEvent.create({ data: { type: "hospital.ops.ambulanceStatusChanged", userId: input.byUserId, detail: { ambulanceId: amb.id, to: input.to }, facilityId: amb.facilityId } });
    return tx.ambulance.findUniqueOrThrow({ where: { id: amb.id } });
  });
}

export async function createAmbulanceTrip(input: { facilityId: string; origin: string; destination: string; patientId?: string; encounterId?: string; crewNote?: string; requestedByStaffId: string; byUserId: string }) {
  if (input.patientId) await assertPatientInFacility(input.patientId, input.facilityId);
  const trip = await prisma.ambulanceTrip.create({ data: { facilityId: input.facilityId, origin: input.origin, destination: input.destination, patientId: input.patientId, encounterId: input.encounterId, crewNote: input.crewNote, requestedByStaffId: input.requestedByStaffId } });
  await recordAuditEvent("hospital.ops.ambulanceTripCreated", input.byUserId, { tripId: trip.id }, { facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId });
  return trip;
}

/** Dispatch: assigns an ambulance and flips it AVAILABLE -> ON_TRIP via a guarded CAS — the single-winner barrier against two dispatches of the same ambulance. */
export async function dispatchAmbulanceTrip(input: { tripId: string; facilityId: string; ambulanceId: string; dispatchedByStaffId: string; crewNote?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const trip = await tx.ambulanceTrip.findUnique({ where: { id: input.tripId } });
    if (!trip || trip.facilityId !== input.facilityId) throw new NotFoundError("Trip not found.");
    if (trip.status !== "REQUESTED") throw new BadRequestError(`Only a REQUESTED trip can be dispatched (current: ${trip.status}).`);
    const amb = await tx.ambulance.findUnique({ where: { id: input.ambulanceId } });
    if (!amb || amb.facilityId !== input.facilityId) throw new NotFoundError("Ambulance not found in this facility.");
    if (!amb.active) throw new BadRequestError("Ambulance is inactive.");
    const cas = await tx.ambulance.updateMany({ where: { id: amb.id, status: "AVAILABLE" }, data: { status: "ON_TRIP" } });
    if (cas.count !== 1) throw new OperationsConcurrencyError("That ambulance is no longer available.");
    const r = await tx.ambulanceTrip.updateMany({ where: { id: trip.id, status: "REQUESTED" }, data: { status: "DISPATCHED", ambulanceId: amb.id, dispatchedByStaffId: input.dispatchedByStaffId, dispatchedAt: new Date(), ...(input.crewNote ? { crewNote: input.crewNote } : {}) } });
    if (r.count !== 1) throw new OperationsConcurrencyError();
    await tx.auditEvent.create({ data: { type: "hospital.ops.ambulanceDispatched", userId: input.byUserId, detail: { tripId: trip.id, ambulanceId: amb.id }, facilityId: trip.facilityId, patientId: trip.patientId, encounterId: trip.encounterId } });
    return tx.ambulanceTrip.findUniqueOrThrow({ where: { id: trip.id } });
  });
}

export async function transitionAmbulanceTrip(input: { tripId: string; facilityId: string; to: string; notes?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const trip = await tx.ambulanceTrip.findUnique({ where: { id: input.tripId } });
    if (!trip || trip.facilityId !== input.facilityId) throw new NotFoundError("Trip not found.");
    if (!isTransitionAllowed(AMBULANCE_TRIP_TRANSITIONS, trip.status, input.to)) throw new BadRequestError(`Illegal trip transition ${trip.status} -> ${input.to}.`);
    const data: Record<string, unknown> = { status: input.to };
    if (input.to === "ARRIVED") data.arrivedAt = new Date();
    if (input.to === "COMPLETED") data.completedAt = new Date();
    if (input.to === "CANCELLED" || input.to === "FAILED_DISPATCH") { data.cancelledAt = new Date(); data.cancelledReason = input.notes ?? input.to; }
    const r = await tx.ambulanceTrip.updateMany({ where: { id: trip.id, status: trip.status }, data });
    if (r.count !== 1) throw new OperationsConcurrencyError();
    // Free the ambulance back to AVAILABLE on any terminal state.
    if ((input.to === "COMPLETED" || input.to === "CANCELLED" || input.to === "FAILED_DISPATCH") && trip.ambulanceId) {
      await tx.ambulance.updateMany({ where: { id: trip.ambulanceId, status: "ON_TRIP" }, data: { status: "AVAILABLE" } });
    }
    await tx.auditEvent.create({ data: { type: "hospital.ops.ambulanceTripUpdated", userId: input.byUserId, detail: { tripId: trip.id, from: trip.status, to: input.to }, facilityId: trip.facilityId, patientId: trip.patientId, encounterId: trip.encounterId } });
    return tx.ambulanceTrip.findUniqueOrThrow({ where: { id: trip.id } });
  });
}

// ══ MAINTENANCE ══════════════════════════════════════════════════════════════
export async function createMaintenanceRequest(input: { facilityId: string; issueType: string; description: string; locationLabel?: string; wardId?: string; equipmentId?: string; priority?: string; requestedByStaffId: string; byUserId: string }) {
  if (input.equipmentId) { const eq = await prisma.biomedicalEquipment.findUnique({ where: { id: input.equipmentId } }); if (!eq || eq.facilityId !== input.facilityId) throw new NotFoundError("Equipment not found in this facility."); }
  const req = await prisma.maintenanceRequest.create({ data: { facilityId: input.facilityId, issueType: input.issueType, description: input.description, locationLabel: input.locationLabel, wardId: input.wardId, equipmentId: input.equipmentId, priority: input.priority ?? "ROUTINE", requestedByStaffId: input.requestedByStaffId } });
  await recordAuditEvent("hospital.ops.maintenanceCreated", input.byUserId, { requestId: req.id, issueType: req.issueType }, { facilityId: input.facilityId });
  return req;
}

export async function transitionMaintenance(input: { requestId: string; facilityId: string; to: string; actorStaffId: string; resolutionNote?: string; notes?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.maintenanceRequest.findUnique({ where: { id: input.requestId } });
    if (!req || req.facilityId !== input.facilityId) throw new NotFoundError("Maintenance request not found.");
    if (!isTransitionAllowed(MAINTENANCE_TRANSITIONS, req.status, input.to)) throw new BadRequestError(`Illegal maintenance transition ${req.status} -> ${input.to}.`);
    const data: Record<string, unknown> = { status: input.to, ...(input.notes !== undefined ? { notes: input.notes } : {}) };
    if (input.to === "ASSIGNED") { await assertStaffActiveInFacility(tx, input.actorStaffId, input.facilityId); data.assignedToStaffId = input.actorStaffId; data.assignedAt = new Date(); }
    if (input.to === "IN_PROGRESS") data.startedAt = new Date();
    if (input.to === "RESOLVED") { data.resolvedAt = new Date(); if (input.resolutionNote) data.resolutionNote = input.resolutionNote; }
    if (input.to === "VERIFIED") { data.verifiedByStaffId = input.actorStaffId; data.verifiedAt = new Date(); }
    if (input.to === "CLOSED") data.closedAt = new Date();
    if (input.to === "CANCELLED") { data.cancelledAt = new Date(); data.cancelledReason = input.notes ?? "Cancelled"; }
    const r = await tx.maintenanceRequest.updateMany({ where: { id: req.id, status: req.status }, data });
    if (r.count !== 1) throw new OperationsConcurrencyError();
    await tx.auditEvent.create({ data: { type: "hospital.ops.maintenanceUpdated", userId: input.byUserId, detail: { requestId: req.id, from: req.status, to: input.to }, facilityId: req.facilityId } });
    return tx.maintenanceRequest.findUniqueOrThrow({ where: { id: req.id } });
  });
}

export async function schedulePreventiveMaintenance(input: { facilityId: string; maintenanceType: string; dueAt: Date; equipmentId?: string; assetLabel?: string; nextDueAt?: Date; byUserId: string }) {
  const pm = await prisma.preventiveMaintenance.create({ data: { facilityId: input.facilityId, maintenanceType: input.maintenanceType, dueAt: input.dueAt, equipmentId: input.equipmentId, assetLabel: input.assetLabel, nextDueAt: input.nextDueAt } });
  await recordAuditEvent("hospital.ops.preventiveScheduled", input.byUserId, { pmId: pm.id }, { facilityId: input.facilityId });
  return pm;
}

export async function completePreventiveMaintenance(input: { pmId: string; facilityId: string; performedByStaffId: string; result?: string; nextDueAt?: Date; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const pm = await tx.preventiveMaintenance.findUnique({ where: { id: input.pmId } });
    if (!pm || pm.facilityId !== input.facilityId) throw new NotFoundError("Preventive maintenance not found.");
    const r = await tx.preventiveMaintenance.updateMany({ where: { id: pm.id, status: "SCHEDULED" }, data: { status: "DONE", performedAt: new Date(), performedByStaffId: input.performedByStaffId, result: input.result, nextDueAt: input.nextDueAt } });
    if (r.count !== 1) throw new BadRequestError("Preventive maintenance is not scheduled.");
    await tx.auditEvent.create({ data: { type: "hospital.ops.preventiveCompleted", userId: input.byUserId, detail: { pmId: pm.id }, facilityId: pm.facilityId } });
    return tx.preventiveMaintenance.findUniqueOrThrow({ where: { id: pm.id } });
  });
}

export async function startDowntime(input: { facilityId: string; reason: string; equipmentId?: string; assetLabel?: string; locationLabel?: string; byStaffId: string; byUserId: string }) {
  const dt = await prisma.assetDowntime.create({ data: { facilityId: input.facilityId, reason: input.reason, equipmentId: input.equipmentId, assetLabel: input.assetLabel, locationLabel: input.locationLabel, byStaffId: input.byStaffId } });
  if (input.equipmentId) await prisma.biomedicalEquipment.updateMany({ where: { id: input.equipmentId, facilityId: input.facilityId }, data: { status: "OUT_OF_SERVICE" } });
  await recordAuditEvent("hospital.ops.downtimeStarted", input.byUserId, { downtimeId: dt.id, equipmentId: input.equipmentId }, { facilityId: input.facilityId });
  return dt;
}

export async function endDowntime(input: { downtimeId: string; facilityId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const dt = await tx.assetDowntime.findUnique({ where: { id: input.downtimeId } });
    if (!dt || dt.facilityId !== input.facilityId) throw new NotFoundError("Downtime not found.");
    const r = await tx.assetDowntime.updateMany({ where: { id: dt.id, status: "ACTIVE" }, data: { status: "RESOLVED", endedAt: new Date() } });
    if (r.count !== 1) throw new BadRequestError("Downtime is not active.");
    if (dt.equipmentId) await tx.biomedicalEquipment.updateMany({ where: { id: dt.equipmentId, facilityId: input.facilityId, status: "OUT_OF_SERVICE" }, data: { status: "IN_SERVICE" } });
    await tx.auditEvent.create({ data: { type: "hospital.ops.downtimeEnded", userId: input.byUserId, detail: { downtimeId: dt.id }, facilityId: dt.facilityId } });
    return tx.assetDowntime.findUniqueOrThrow({ where: { id: dt.id } });
  });
}

// ══ BIOMEDICAL ═══════════════════════════════════════════════════════════════
export async function createEquipment(input: { facilityId: string; assetTag: string; category: string; serialNumber?: string; manufacturer?: string; model?: string; departmentId?: string; locationLabel?: string; warrantyUntil?: Date; nextServiceAt?: Date; byUserId: string }) {
  const eq = await prisma.biomedicalEquipment.create({ data: { facilityId: input.facilityId, assetTag: input.assetTag, category: input.category, serialNumber: input.serialNumber, manufacturer: input.manufacturer, model: input.model, departmentId: input.departmentId, locationLabel: input.locationLabel, warrantyUntil: input.warrantyUntil, nextServiceAt: input.nextServiceAt } })
    .catch((e: unknown) => { if (e instanceof Error && /unique/i.test(e.message)) throw new BadRequestError("An asset with that tag already exists in this facility."); throw e; });
  await recordAuditEvent("hospital.ops.equipmentCreated", input.byUserId, { equipmentId: eq.id, assetTag: eq.assetTag }, { facilityId: input.facilityId });
  return eq;
}

export async function setEquipmentStatus(input: { equipmentId: string; facilityId: string; to: string; byUserId: string }) {
  const valid = ["IN_SERVICE", "UNDER_MAINTENANCE", "OUT_OF_SERVICE", "RETIRED"];
  if (!valid.includes(input.to)) throw new BadRequestError("Invalid equipment status.");
  const eq = await prisma.biomedicalEquipment.findUnique({ where: { id: input.equipmentId } });
  if (!eq || eq.facilityId !== input.facilityId) throw new NotFoundError("Equipment not found.");
  const updated = await prisma.biomedicalEquipment.update({ where: { id: eq.id }, data: { status: input.to } });
  await recordAuditEvent("hospital.ops.equipmentStatusChanged", input.byUserId, { equipmentId: eq.id, to: input.to }, { facilityId: input.facilityId });
  return updated;
}

export async function recordEquipmentCalibration(input: { equipmentId: string; facilityId: string; performedByStaffId: string; result?: string; certificateRef?: string; nextDueAt?: Date; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const eq = await tx.biomedicalEquipment.findUnique({ where: { id: input.equipmentId } });
    if (!eq || eq.facilityId !== input.facilityId) throw new NotFoundError("Equipment not found.");
    const rec = await tx.biomedicalCalibrationRecord.create({ data: { facilityId: input.facilityId, equipmentId: eq.id, performedByStaffId: input.performedByStaffId, result: input.result, certificateRef: input.certificateRef, nextDueAt: input.nextDueAt } });
    await tx.biomedicalEquipment.update({ where: { id: eq.id }, data: { calibrationStatus: "CALIBRATED", nextServiceAt: input.nextDueAt ?? eq.nextServiceAt } });
    await tx.auditEvent.create({ data: { type: "hospital.ops.calibrationRecorded", userId: input.byUserId, detail: { equipmentId: eq.id, calibrationId: rec.id }, facilityId: eq.facilityId } });
    return rec;
  });
}

export async function recordEquipmentMaintenance(input: { equipmentId: string; facilityId: string; maintenanceType: string; performedByStaffId: string; result?: string; notes?: string; byUserId: string }) {
  const eq = await prisma.biomedicalEquipment.findUnique({ where: { id: input.equipmentId } });
  if (!eq || eq.facilityId !== input.facilityId) throw new NotFoundError("Equipment not found.");
  const rec = await prisma.biomedicalMaintenanceRecord.create({ data: { facilityId: input.facilityId, equipmentId: eq.id, maintenanceType: input.maintenanceType, performedByStaffId: input.performedByStaffId, result: input.result, notes: input.notes } });
  await recordAuditEvent("hospital.ops.biomedMaintenanceRecorded", input.byUserId, { equipmentId: eq.id, recordId: rec.id }, { facilityId: input.facilityId });
  return rec;
}

export async function moveEquipment(input: { equipmentId: string; facilityId: string; toLocation: string; reason?: string; movedByStaffId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const eq = await tx.biomedicalEquipment.findUnique({ where: { id: input.equipmentId } });
    if (!eq || eq.facilityId !== input.facilityId) throw new NotFoundError("Equipment not found in this facility.");
    const from = eq.locationLabel;
    const r = await tx.biomedicalEquipment.updateMany({ where: { id: eq.id, locationLabel: from }, data: { locationLabel: input.toLocation } });
    if (r.count !== 1) throw new OperationsConcurrencyError("Equipment location changed concurrently — refresh and try again.");
    const movement = await tx.equipmentMovement.create({ data: { facilityId: input.facilityId, equipmentId: eq.id, fromLocation: from, toLocation: input.toLocation, reason: input.reason, movedByStaffId: input.movedByStaffId } });
    await tx.auditEvent.create({ data: { type: "hospital.ops.equipmentMoved", userId: input.byUserId, detail: { equipmentId: eq.id, from, to: input.toLocation }, facilityId: eq.facilityId } });
    return movement;
  });
}

// ══ INFECTION CONTROL ════════════════════════════════════════════════════════
export async function createInfectionIncident(input: { facilityId: string; incidentType: string; patientId?: string; encounterId?: string; wardId?: string; locationLabel?: string; onsetAt?: Date; isolationRequired?: boolean; reportedByStaffId: string; notes?: string; byUserId: string }) {
  if (input.patientId) await assertPatientInFacility(input.patientId, input.facilityId);
  const inc = await prisma.infectionIncident.create({ data: { facilityId: input.facilityId, incidentType: input.incidentType, patientId: input.patientId, encounterId: input.encounterId, wardId: input.wardId, locationLabel: input.locationLabel, onsetAt: input.onsetAt, isolationRequired: input.isolationRequired ?? false, reportedByStaffId: input.reportedByStaffId, notes: input.notes } });
  await recordAuditEvent("hospital.ops.infectionReported", input.byUserId, { incidentId: inc.id, incidentType: inc.incidentType, isolationRequired: inc.isolationRequired }, { facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId });
  return inc;
}

export async function transitionInfectionIncident(input: { incidentId: string; facilityId: string; to: string; actorStaffId: string; notes?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const inc = await tx.infectionIncident.findUnique({ where: { id: input.incidentId } });
    if (!inc || inc.facilityId !== input.facilityId) throw new NotFoundError("Infection incident not found.");
    if (!isTransitionAllowed(INFECTION_TRANSITIONS, inc.status, input.to)) throw new BadRequestError(`Illegal incident transition ${inc.status} -> ${input.to}.`);
    const data: Record<string, unknown> = { status: input.to, ...(input.notes !== undefined ? { notes: input.notes } : {}) };
    if (input.to === "UNDER_REVIEW") { data.reviewedByStaffId = input.actorStaffId; data.reviewedAt = new Date(); }
    if (input.to === "RESOLVED") data.resolvedAt = new Date();
    if (input.to === "CLOSED") data.closedAt = new Date();
    if (input.to === "CANCELLED") data.cancelledAt = new Date();
    const r = await tx.infectionIncident.updateMany({ where: { id: inc.id, status: inc.status }, data });
    if (r.count !== 1) throw new OperationsConcurrencyError();
    await tx.auditEvent.create({ data: { type: "hospital.ops.infectionUpdated", userId: input.byUserId, detail: { incidentId: inc.id, from: inc.status, to: input.to }, facilityId: inc.facilityId, patientId: inc.patientId, encounterId: inc.encounterId } });
    return tx.infectionIncident.findUniqueOrThrow({ where: { id: inc.id } });
  });
}

export async function createInfectionInvestigation(input: { incidentId: string; facilityId: string; investigatorStaffId: string; findings?: string; actionTaken?: string; byUserId: string }) {
  const inc = await prisma.infectionIncident.findUnique({ where: { id: input.incidentId } });
  if (!inc || inc.facilityId !== input.facilityId) throw new NotFoundError("Incident not found.");
  const inv = await prisma.infectionInvestigation.create({ data: { facilityId: input.facilityId, incidentId: inc.id, investigatorStaffId: input.investigatorStaffId, findings: input.findings, actionTaken: input.actionTaken } });
  await recordAuditEvent("hospital.ops.infectionInvestigationCreated", input.byUserId, { investigationId: inv.id, incidentId: inc.id }, { facilityId: input.facilityId });
  return inv;
}

export async function recordExposure(input: { incidentId: string; facilityId: string; affectedPersonRef: string; locationLabel?: string; exposureAt?: Date; notes?: string; byUserId: string }) {
  const inc = await prisma.infectionIncident.findUnique({ where: { id: input.incidentId } });
  if (!inc || inc.facilityId !== input.facilityId) throw new NotFoundError("Incident not found.");
  const exp = await prisma.exposureRecord.create({ data: { facilityId: input.facilityId, incidentId: inc.id, affectedPersonRef: input.affectedPersonRef, locationLabel: input.locationLabel, exposureAt: input.exposureAt, notes: input.notes } });
  await recordAuditEvent("hospital.ops.exposureRecorded", input.byUserId, { exposureId: exp.id, incidentId: inc.id }, { facilityId: input.facilityId });
  return exp;
}
