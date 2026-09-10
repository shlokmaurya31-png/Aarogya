import { prisma } from "@/lib/db";

/**
 * Operations Command Center (Phase B9) — every count is a live, facility-scoped,
 * indexed DB query. "Overdue" is derived from timestamps vs a simple threshold
 * (reusing the SLA-threshold convention, not a second SLA engine). No fabricated
 * metrics.
 */
export async function getOperationsCommandCenter(facilityId: string) {
  const now = Date.now();
  const overdueHousekeeping = new Date(now - 60 * 60_000); // 60m open
  const overdueTransport = new Date(now - 30 * 60_000); // 30m open
  const overdueMaintenanceUrgent = new Date(now - 4 * 60 * 60_000); // 4h open
  const soon = new Date(now + 7 * 24 * 3600_000);
  const past = new Date(now);

  const [
    hkPending, hkAssigned, hkInProgress, hkOverdue, hkAwaitingInspection,
    mealsPending, mealsPreparing, mealsReady, mealsMissedRefused,
    transportPending, transportActive, transportOverdue,
    ambAvailable, ambDispatchedOrTrip, ambUnavailable, tripsActive,
    maintOpen, maintUrgent, maintAssigned, maintOverdue,
    equipOutOfService, calibrationDue, pmDue,
    infectionOpen, infectionInvestigation, infectionActionRequired,
  ] = await Promise.all([
    prisma.housekeepingRequest.count({ where: { facilityId, status: "REQUESTED" } }),
    prisma.housekeepingRequest.count({ where: { facilityId, status: "ASSIGNED" } }),
    prisma.housekeepingRequest.count({ where: { facilityId, status: "IN_PROGRESS" } }),
    prisma.housekeepingRequest.count({ where: { facilityId, status: { in: ["REQUESTED", "ASSIGNED"] }, requestedAt: { lte: overdueHousekeeping } } }),
    prisma.housekeepingRequest.count({ where: { facilityId, status: "COMPLETED" } }),
    prisma.meal.count({ where: { facilityId, status: "PLANNED" } }),
    prisma.meal.count({ where: { facilityId, status: "PREPARING" } }),
    prisma.meal.count({ where: { facilityId, status: "READY" } }),
    prisma.meal.count({ where: { facilityId, status: { in: ["MISSED", "REFUSED"] } } }),
    prisma.patientTransportRequest.count({ where: { facilityId, status: { in: ["REQUESTED", "ACCEPTED", "ASSIGNED"] } } }),
    prisma.patientTransportRequest.count({ where: { facilityId, status: { in: ["EN_ROUTE_TO_PICKUP", "PATIENT_PICKED_UP", "IN_TRANSIT", "ARRIVED"] } } }),
    prisma.patientTransportRequest.count({ where: { facilityId, status: { in: ["REQUESTED", "ACCEPTED", "ASSIGNED"] }, requestedAt: { lte: overdueTransport } } }),
    prisma.ambulance.count({ where: { facilityId, status: "AVAILABLE", active: true } }),
    prisma.ambulance.count({ where: { facilityId, status: "ON_TRIP" } }),
    prisma.ambulance.count({ where: { facilityId, status: { in: ["MAINTENANCE", "OUT_OF_SERVICE"] } } }),
    prisma.ambulanceTrip.count({ where: { facilityId, status: { in: ["DISPATCHED", "EN_ROUTE", "AT_PICKUP", "PATIENT_ONBOARD", "IN_TRANSIT", "ARRIVED"] } } }),
    prisma.maintenanceRequest.count({ where: { facilityId, status: { notIn: ["CLOSED", "CANCELLED"] } } }),
    prisma.maintenanceRequest.count({ where: { facilityId, status: { notIn: ["CLOSED", "CANCELLED", "RESOLVED", "VERIFIED"] }, priority: { in: ["URGENT", "STAT"] } } }),
    prisma.maintenanceRequest.count({ where: { facilityId, status: { in: ["ASSIGNED", "IN_PROGRESS"] } } }),
    prisma.maintenanceRequest.count({ where: { facilityId, status: { in: ["REPORTED", "TRIAGED", "ASSIGNED"] }, priority: { in: ["URGENT", "STAT"] }, reportedAt: { lte: overdueMaintenanceUrgent } } }),
    prisma.biomedicalEquipment.count({ where: { facilityId, status: { in: ["OUT_OF_SERVICE", "UNDER_MAINTENANCE"] } } }),
    prisma.biomedicalEquipment.count({ where: { facilityId, OR: [{ calibrationStatus: { in: ["DUE", "OVERDUE"] } }, { nextServiceAt: { not: null, lte: soon } }] } }),
    prisma.preventiveMaintenance.count({ where: { facilityId, status: "SCHEDULED", dueAt: { lte: past } } }),
    prisma.infectionIncident.count({ where: { facilityId, status: { notIn: ["CLOSED", "CANCELLED"] } } }),
    prisma.infectionIncident.count({ where: { facilityId, status: "INVESTIGATION" } }),
    prisma.infectionIncident.count({ where: { facilityId, status: "ACTION_REQUIRED" } }),
  ]);

  return {
    housekeeping: { pending: hkPending, assigned: hkAssigned, inProgress: hkInProgress, overdue: hkOverdue, awaitingInspection: hkAwaitingInspection },
    dietary: { pending: mealsPending, preparing: mealsPreparing, ready: mealsReady, missedRefused: mealsMissedRefused },
    transport: { pending: transportPending, active: transportActive, overdue: transportOverdue },
    ambulance: { available: ambAvailable, onTrip: ambDispatchedOrTrip, unavailable: ambUnavailable, activeTrips: tripsActive },
    maintenance: { open: maintOpen, urgent: maintUrgent, assigned: maintAssigned, overdue: maintOverdue },
    biomedical: { outOfService: equipOutOfService, calibrationDue, preventiveDue: pmDue },
    infectionControl: { open: infectionOpen, investigation: infectionInvestigation, actionRequired: infectionActionRequired },
  };
}

/** Outbreak workspace: grouping of open/related incidents by type + ward (documentary, no epidemiological inference). */
export async function getOutbreakWorkspace(facilityId: string, opts?: { sinceDays?: number }) {
  const since = new Date(Date.now() - (opts?.sinceDays ?? 30) * 24 * 3600_000);
  const grouped = await prisma.infectionIncident.groupBy({
    by: ["incidentType", "wardId"],
    where: { facilityId, reportedAt: { gte: since }, status: { notIn: ["CANCELLED"] } },
    _count: { _all: true },
  });
  return grouped.map((g) => ({ incidentType: g.incidentType, wardId: g.wardId, count: g._count._all })).filter((g) => g.count > 1).sort((a, b) => b.count - a.count);
}
