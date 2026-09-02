import { prisma } from "@/lib/db";
import { getSlaThresholds } from "./sla";

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

  // Phase 2 — Patient Flow SLA breaches (brief §51-52). Thresholds come from
  // getSlaThresholds() — configurable hospital operational policy, not a
  // hard-coded clinical standard (brief §52's explicit instruction).
  const sla = await getSlaThresholds(facilityId);

  const waitingEd = await prisma.queueEntry.findMany({
    where: { facilityId, queueType: "ED", status: "WAITING" },
    include: { patient: true },
  });
  for (const q of waitingEd) {
    const minutes = (now - q.enteredAt.getTime()) / 60_000;
    if (minutes >= sla.ED_DOCTOR_WAIT) {
      alerts.push({
        id: `ed-wait-${q.id}`,
        severity: minutes >= sla.ED_DOCTOR_WAIT * 2 ? "critical" : "watch",
        department: "Emergency",
        message: `${q.patient.fullName} has been waiting ${Math.round(minutes)} min for an ED doctor (SLA ${sla.ED_DOCTOR_WAIT} min).`,
        ownerRole: "DOCTOR",
        createdAt: q.enteredAt.toISOString(),
      });
    }
  }

  const pendingAdmissionRequests = await prisma.admissionRequest.findMany({
    where: { facilityId, status: { in: ["PENDING", "DEFERRED"] } },
    include: { patient: true },
  });
  for (const r of pendingAdmissionRequests) {
    const minutes = (now - r.createdAt.getTime()) / 60_000;
    if (minutes >= sla.ADMISSION_ALLOCATION) {
      alerts.push({
        id: `admission-request-sla-${r.id}`,
        severity: minutes >= sla.ADMISSION_ALLOCATION * 2 ? "critical" : "watch",
        department: "Bed Management",
        message: `Admission request for ${r.patient.fullName} has waited ${Math.round(minutes)} min for bed allocation (SLA ${sla.ADMISSION_ALLOCATION} min).`,
        ownerRole: "HOSPITAL_ADMIN",
        createdAt: r.createdAt.toISOString(),
      });
    }
  }

  const reservedNotAdmitted = await prisma.admissionRequest.findMany({
    where: { facilityId, status: "BED_RESERVED" },
    include: { patient: true, reservedBed: true },
  });
  for (const r of reservedNotAdmitted) {
    const minutes = r.reviewedAt ? (now - r.reviewedAt.getTime()) / 60_000 : 0;
    if (minutes >= sla.ADMISSION_ALLOCATION) {
      alerts.push({
        id: `bed-reserved-stalled-${r.id}`,
        severity: "watch",
        department: "Bed Management",
        message: `Bed ${r.reservedBed?.label ?? "?"} reserved for ${r.patient.fullName} but admission not yet confirmed (${Math.round(minutes)} min).`,
        ownerRole: "HOSPITAL_ADMIN",
        createdAt: (r.reviewedAt ?? r.createdAt).toISOString(),
      });
    }
  }

  const pendingTransfers = await prisma.transferRequest.findMany({
    where: { facilityId, status: { notIn: ["COMPLETED", "CANCELLED", "REJECTED"] } },
    include: { patient: true },
  });
  for (const t of pendingTransfers) {
    const minutes = (now - t.createdAt.getTime()) / 60_000;
    if (minutes >= sla.TRANSFER) {
      alerts.push({
        id: `transfer-sla-${t.id}`,
        severity: minutes >= sla.TRANSFER * 2 ? "critical" : "watch",
        department: "Bed Management",
        message: `Transfer request for ${t.patient.fullName} has been pending ${Math.round(minutes)} min (SLA ${sla.TRANSFER} min).`,
        ownerRole: "HOSPITAL_ADMIN",
        createdAt: t.createdAt.toISOString(),
      });
    }
  }

  const readyDischarges = await prisma.discharge.findMany({
    where: {
      dischargedAt: null,
      clinicallyReady: true,
      admission: { encounter: { facilityId } },
    },
    include: { admission: { include: { encounter: { include: { patient: true } }, bed: true } } },
  });
  for (const d of readyDischarges) {
    const minutes = (now - d.initiatedAt.getTime()) / 60_000;
    if (minutes >= sla.DISCHARGE_READY) {
      alerts.push({
        id: `discharge-ready-sla-${d.id}`,
        severity: minutes >= sla.DISCHARGE_READY * 2 ? "critical" : "watch",
        department: "Discharge",
        message: `${d.admission.encounter.patient.fullName} has been medically ready to leave for ${Math.round(minutes)} min (bed ${d.admission.bed.label}) — SLA ${sla.DISCHARGE_READY} min.`,
        ownerRole: "HOSPITAL_ADMIN",
        createdAt: d.initiatedAt.toISOString(),
      });
    }
  }

  const severityOrder = { critical: 0, watch: 1, info: 2 };
  return alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
}
