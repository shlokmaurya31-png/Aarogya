import { prisma } from "@/lib/db";
import { computeAlerts } from "./alertEngine";

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Every number here is a live Prisma aggregate, not a placeholder (brief
 * §138). Comparisons against a rolling average (brief §137's "18% above
 * weekday average" style insight) are computed from the same table, not
 * invented.
 */
export async function getCommandCenterSnapshot(facilityId: string) {
  const today = startOfToday();
  const sevenDaysAgo = new Date(today.getTime() - 7 * 86_400_000);

  const [
    bedsByStatus,
    bedsByWardType,
    admissionsToday,
    dischargesToday,
    edArrivalsToday,
    opdArrivalsToday,
    admissionsLast7Days,
    activeEncounters,
    criticalLabCount,
    criticalImagingCount,
    pendingDischarges,
    totalBeds,
    availableBeds,
    appointmentsToday,
    noShowsToday,
    opdWaiting,
    edWaiting,
    queueByTypeStatus,
    pendingAdmissionRequests,
    reservedNotAdmitted,
    pendingTransfers,
    readyDischarges,
  ] = await Promise.all([
    prisma.bed.groupBy({ by: ["status"], where: { facilityId }, _count: true }),
    prisma.bed.findMany({ where: { facilityId }, include: { ward: true } }),
    prisma.admission.count({ where: { admittedAt: { gte: today }, encounter: { facilityId } } }),
    prisma.discharge.count({ where: { dischargedAt: { gte: today }, admission: { encounter: { facilityId } } } }),
    prisma.encounter.count({ where: { facilityId, type: "ED", registeredAt: { gte: today } } }),
    prisma.encounter.count({ where: { facilityId, type: "OPD", registeredAt: { gte: today } } }),
    prisma.admission.count({ where: { admittedAt: { gte: sevenDaysAgo, lt: today }, encounter: { facilityId } } }),
    prisma.encounter.findMany({
      where: { facilityId, status: { notIn: ["DISCHARGED", "CLOSED"] } },
      select: { status: true, type: true },
    }),
    prisma.labResult.count({ where: { isCritical: true, acknowledgedAt: null, labOrder: { encounter: { facilityId } } } }),
    prisma.imagingReport.count({ where: { isCritical: true, verifiedAt: null, imagingOrder: { encounter: { facilityId } } } }),
    prisma.discharge.count({ where: { dischargedAt: null, admission: { encounter: { facilityId } } } }),
    prisma.bed.count({ where: { facilityId } }),
    prisma.bed.count({ where: { facilityId, status: "AVAILABLE" } }),
    prisma.appointment.count({ where: { facilityId, scheduledStart: { gte: today } } }),
    prisma.appointment.count({ where: { facilityId, status: "NO_SHOW", noShowAt: { gte: today } } }),
    prisma.queueEntry.count({ where: { facilityId, queueType: "OPD_DOCTOR", status: "WAITING" } }),
    prisma.queueEntry.count({ where: { facilityId, queueType: "ED", status: "WAITING" } }),
    prisma.queueEntry.groupBy({ by: ["queueType", "status"], where: { facilityId, status: { in: ["WAITING", "CALLED", "IN_SERVICE"] } }, _count: true }),
    prisma.admissionRequest.count({ where: { facilityId, status: { in: ["PENDING", "DEFERRED"] } } }),
    prisma.admissionRequest.count({ where: { facilityId, status: "BED_RESERVED" } }),
    prisma.transferRequest.count({ where: { facilityId, status: { notIn: ["COMPLETED", "CANCELLED", "REJECTED"] } } }),
    prisma.discharge.count({ where: { dischargedAt: null, clinicallyReady: true, admission: { encounter: { facilityId } } } }),
  ]);

  const avgDailyAdmissionsLast7 = admissionsLast7Days / 7;
  const admissionsDeltaPct = avgDailyAdmissionsLast7 > 0 ? Math.round(((admissionsToday - avgDailyAdmissionsLast7) / avgDailyAdmissionsLast7) * 100) : 0;

  const wardOccupancy = new Map<string, { wardType: string; occupied: number; total: number }>();
  for (const bed of bedsByWardType) {
    const key = bed.ward.name;
    const acc = wardOccupancy.get(key) ?? { wardType: bed.ward.wardType, occupied: 0, total: 0 };
    acc.total += 1;
    if (bed.status === "OCCUPIED") acc.occupied += 1;
    wardOccupancy.set(key, acc);
  }

  const patientFlow = { REGISTERED: 0, TRIAGED: 0, IN_CONSULTATION: 0, INVESTIGATING: 0, ADMITTED: 0 } as Record<string, number>;
  for (const e of activeEncounters) {
    patientFlow[e.status] = (patientFlow[e.status] ?? 0) + 1;
  }

  const occupancyPct = totalBeds > 0 ? Math.round(((totalBeds - availableBeds) / totalBeds) * 100) : 0;
  const operationalStatus: "green" | "watch" | "critical" =
    occupancyPct >= 95 || criticalLabCount + criticalImagingCount >= 3 ? "critical" : occupancyPct >= 85 || criticalLabCount + criticalImagingCount >= 1 ? "watch" : "green";

  const alerts = await computeAlerts(facilityId);

  return {
    today: {
      admissions: admissionsToday,
      admissionsDeltaPct,
      discharges: dischargesToday,
      edVisits: edArrivalsToday,
      opdVisits: opdArrivalsToday,
    },
    beds: {
      total: totalBeds,
      available: availableBeds,
      occupancyPct,
      byStatus: Object.fromEntries(bedsByStatus.map((b) => [b.status, b._count])),
      byWard: [...wardOccupancy.entries()].map(([wardName, v]) => ({ wardName, ...v })),
    },
    patientFlow,
    safety: {
      unacknowledgedCriticalLabs: criticalLabCount,
      unverifiedCriticalImaging: criticalImagingCount,
      pendingDischarges,
    },
    // Phase 2 — Patient Flow (brief §50): every number below is a live
    // Prisma aggregate over the same request/queue tables the operational
    // routes write to, not a decorative estimate.
    access: {
      appointmentsToday,
      noShowsToday,
      opdWaiting,
      edWaiting,
    },
    patientFlowOps: {
      queues: queueByTypeStatus.map((q) => ({ queueType: q.queueType, status: q.status, count: q._count })),
      admissionRequestsPending: pendingAdmissionRequests,
      admissionRequestsBedReserved: reservedNotAdmitted,
      transferBacklog: pendingTransfers,
      dischargeReadyNotLeft: readyDischarges,
    },
    operationalStatus,
    alerts,
  };
}
