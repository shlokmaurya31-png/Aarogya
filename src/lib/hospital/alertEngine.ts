import { prisma } from "@/lib/db";

/**
 * Deterministic rule engine — not an LLM (brief §138 "do not invent
 * analytics"). Every alert is derived from a real DB condition and carries
 * the "why" the brief's §137 asks for, not a decorative number. Scoped to a
 * single facility (tenant isolation — see docs/ENTERPRISE_HOSPITAL_ARCHITECTURE.md §3).
 */
export interface HospitalAlert {
  id: string;
  severity: "info" | "watch" | "critical";
  department: string;
  message: string;
  ownerRole: string;
  createdAt: string;
}

const BLOCKED_BED_WATCH_HOURS = 4;
const DISCHARGE_STALL_WATCH_HOURS = 6;

export async function computeAlerts(facilityId: string): Promise<HospitalAlert[]> {
  const alerts: HospitalAlert[] = [];
  const now = Date.now();

  // Blocked/maintenance beds sitting idle beyond the watch threshold.
  const blockedBeds = await prisma.bed.findMany({
    where: { facilityId, status: { in: ["BLOCKED", "MAINTENANCE"] } },
    include: { ward: true, stateEvents: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  for (const bed of blockedBeds) {
    const since = bed.stateEvents[0]?.createdAt ?? bed.updatedAt;
    const hours = (now - since.getTime()) / 3_600_000;
    if (hours >= BLOCKED_BED_WATCH_HOURS) {
      alerts.push({
        id: `bed-blocked-${bed.id}`,
        severity: hours >= BLOCKED_BED_WATCH_HOURS * 3 ? "critical" : "watch",
        department: bed.ward.name,
        message: `Bed ${bed.label} in ${bed.ward.name} has been ${bed.status.toLowerCase()} for ${Math.round(hours)}h — ${bed.stateEvents[0]?.reason ?? "no reason recorded"}.`,
        ownerRole: "HOSPITAL_ADMIN",
        createdAt: since.toISOString(),
      });
    }
  }

  // Unacknowledged critical lab results.
  const criticalLabs = await prisma.labResult.findMany({
    where: { isCritical: true, acknowledgedAt: null },
    include: { labOrder: { include: { encounter: { include: { patient: true, department: true } } } } },
  });
  for (const result of criticalLabs) {
    if (result.labOrder.encounter.facilityId !== facilityId) continue;
    const hours = (now - result.resultedAt.getTime()) / 3_600_000;
    alerts.push({
      id: `lab-critical-${result.id}`,
      severity: hours >= 1 ? "critical" : "watch",
      department: result.labOrder.encounter.department?.name ?? result.labOrder.category,
      message: `Critical lab result unacknowledged for ${result.labOrder.encounter.patient.fullName} (${result.labOrder.testName}: ${result.value} ${result.unit ?? ""}) — resulted ${Math.round(hours * 60)} min ago.`,
      ownerRole: "DOCTOR",
      createdAt: result.resultedAt.toISOString(),
    });
  }

  // Unverified critical imaging reports.
  const criticalImaging = await prisma.imagingReport.findMany({
    where: { isCritical: true, verifiedAt: null },
    include: { imagingOrder: { include: { encounter: { include: { patient: true, department: true } } } } },
  });
  for (const report of criticalImaging) {
    if (report.imagingOrder.encounter.facilityId !== facilityId) continue;
    alerts.push({
      id: `imaging-critical-${report.id}`,
      severity: "critical",
      department: report.imagingOrder.encounter.department?.name ?? report.imagingOrder.modality,
      message: `Critical imaging finding unverified for ${report.imagingOrder.encounter.patient.fullName} (${report.imagingOrder.modality}: ${report.impression}).`,
      ownerRole: "DOCTOR",
      createdAt: report.reportedAt.toISOString(),
    });
  }

  // Discharges initiated but stalled on a readiness flag.
  const discharges = await prisma.discharge.findMany({
    where: { dischargedAt: null },
    include: { admission: { include: { encounter: { include: { patient: true } }, bed: true } } },
  });
  for (const d of discharges) {
    if (d.admission.encounter.facilityId !== facilityId) continue;
    const hours = (now - d.initiatedAt.getTime()) / 3_600_000;
    if (hours < DISCHARGE_STALL_WATCH_HOURS) continue;
    const pending = (["clinicallyReady", "documentationReady", "billingReady", "insuranceReady", "pharmacyReady", "transportReady"] as const).filter(
      (k) => !d[k]
    );
    if (pending.length === 0) continue;
    alerts.push({
      id: `discharge-stalled-${d.id}`,
      severity: hours >= DISCHARGE_STALL_WATCH_HOURS * 2 ? "critical" : "watch",
      department: "Discharge",
      message: `${d.admission.encounter.patient.fullName} (bed ${d.admission.bed.label}) has been discharge-ready ${Math.round(hours)}h, blocked on: ${pending.join(", ")}.`,
      ownerRole: "HOSPITAL_ADMIN",
      createdAt: d.initiatedAt.toISOString(),
    });
  }

  // Facility-wide bed-shortage watch.
  const [available, total] = await Promise.all([
    prisma.bed.count({ where: { facilityId, status: "AVAILABLE" } }),
    prisma.bed.count({ where: { facilityId } }),
  ]);
  if (total > 0) {
    const occupancyPct = Math.round(((total - available) / total) * 100);
    if (occupancyPct >= 90) {
      alerts.push({
        id: "bed-shortage",
        severity: occupancyPct >= 97 ? "critical" : "watch",
        department: "Hospital-wide",
        message: `Bed occupancy is at ${occupancyPct}% (${available}/${total} available) — approaching capacity.`,
        ownerRole: "HOSPITAL_ADMIN",
        createdAt: new Date().toISOString(),
      });
    }
  }

  const severityOrder = { critical: 0, watch: 1, info: 2 };
  return alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
}
