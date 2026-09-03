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

  // Unacknowledged critical lab results. isCurrent:true so an amended
  // (superseded) row's stale isCritical/acknowledgedAt state can't keep
  // alerting forever after the current version supersedes it.
  // Milestone E hardening — this query previously had no facility filter in
  // the `where` clause and relied entirely on the loop's `continue` below to
  // drop other tenants' rows after fetching them into memory (a landmine:
  // any future refactor that dropped the `continue` — e.g. a `.map()`
  // rewrite, or a `take` cap added "for performance" before the filter —
  // would leak another facility's critical lab values/patient names into
  // this facility's alert feed). Every other query in this file already
  // filters by facilityId in `where`; this now matches that convention.
  const criticalLabs = await prisma.labResult.findMany({
    where: { isCritical: true, acknowledgedAt: null, isCurrent: true, labOrder: { encounter: { facilityId } } },
    include: { labOrder: { include: { encounter: { include: { patient: true, department: true } } } } },
  });
  for (const result of criticalLabs) {
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

  // Unacknowledged critical imaging findings. Deliberately keyed on
  // acknowledgedAt (Milestone C) rather than verifiedAt — verification is
  // report sign-off, acknowledgement is critical-finding clearance; the
  // original schema conflated these into one verifiedAt field.
  // Milestone E hardening — same fix as criticalLabs above.
  const criticalImaging = await prisma.imagingReport.findMany({
    where: { isCritical: true, acknowledgedAt: null, isCurrent: true, imagingOrder: { encounter: { facilityId } } },
    include: { imagingOrder: { include: { encounter: { include: { patient: true, department: true } } } } },
  });
  for (const report of criticalImaging) {
    alerts.push({
      id: `imaging-critical-${report.id}`,
      severity: "critical",
      department: report.imagingOrder.encounter.department?.name ?? report.imagingOrder.modality,
      message: `Critical imaging finding unacknowledged for ${report.imagingOrder.encounter.patient.fullName} (${report.imagingOrder.modality}: ${report.impression}).`,
      ownerRole: "DOCTOR",
      createdAt: report.reportedAt.toISOString(),
    });
  }

  // Discharges initiated but stalled on a readiness flag.
  // Milestone E hardening — same fix as criticalLabs above.
  const discharges = await prisma.discharge.findMany({
    where: { dischargedAt: null, admission: { encounter: { facilityId } } },
    include: { admission: { include: { encounter: { include: { patient: true } }, bed: true } } },
  });
  for (const d of discharges) {
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

  // Phase 3 — Doctor OS / Nursing OS / Medication Lifecycle / Pharmacy
  // alerts (brief §27). Every one computed live from real order/task/
  // warning state, same pattern as everything above.
  const OVERDUE_MED_MINUTES = 30;
  const overdueMeds = await prisma.medicationAdministration.findMany({
    where: { status: "DUE", scheduledAt: { lte: new Date(now - OVERDUE_MED_MINUTES * 60_000) }, medicationOrder: { encounter: { facilityId } } },
    include: { medicationOrder: { include: { patient: true } } },
  });
  for (const m of overdueMeds) {
    const minutes = Math.round((now - m.scheduledAt.getTime()) / 60_000);
    alerts.push({
      id: `med-overdue-${m.id}`,
      severity: minutes >= OVERDUE_MED_MINUTES * 3 ? "critical" : "watch",
      department: "Nursing",
      message: `${m.medicationOrder.patient.fullName}'s ${m.medicationOrder.drugName} dose is ${minutes} min overdue.`,
      ownerRole: "NURSE",
      createdAt: m.scheduledAt.toISOString(),
    });
  }

  const overdueTasks = await prisma.task.findMany({
    where: { facilityId, status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS"] }, dueAt: { lte: new Date(now) } },
    include: { patient: true },
    take: 30,
  });
  for (const t of overdueTasks) {
    if (!t.dueAt) continue;
    const minutes = Math.round((now - t.dueAt.getTime()) / 60_000);
    alerts.push({
      id: `task-overdue-${t.id}`,
      severity: minutes >= 120 ? "critical" : "watch",
      department: "Nursing",
      message: `${t.title}${t.patient ? ` for ${t.patient.fullName}` : ""} is ${minutes} min overdue.`,
      ownerRole: "NURSE",
      createdAt: t.dueAt.toISOString(),
    });
  }

  const unresolvedDangerWarnings = await prisma.medicationSafetyWarning.findMany({
    where: { severity: "DANGER", acknowledgedAt: null, medicationOrder: { encounter: { facilityId } } },
    include: { medicationOrder: { include: { patient: true } } },
  });
  for (const w of unresolvedDangerWarnings) {
    alerts.push({
      id: `safety-unresolved-${w.id}`,
      severity: "critical",
      department: "Pharmacy",
      message: `Unresolved DANGER safety warning for ${w.medicationOrder.patient.fullName}'s ${w.medicationOrder.drugName}: ${w.message}`,
      ownerRole: "PHARMACIST",
      createdAt: w.createdAt.toISOString(),
    });
  }

  const PENDING_VERIFICATION_MINUTES = 30;
  const pendingVerification = await prisma.medicationOrder.findMany({
    where: { status: "PHARMACY_REVIEW", encounter: { facilityId }, orderedAt: { lte: new Date(now - PENDING_VERIFICATION_MINUTES * 60_000) } },
    include: { patient: true },
  });
  for (const o of pendingVerification) {
    const minutes = Math.round((now - o.orderedAt.getTime()) / 60_000);
    alerts.push({
      id: `pharmacy-pending-${o.id}`,
      severity: minutes >= PENDING_VERIFICATION_MINUTES * 2 ? "critical" : "watch",
      department: "Pharmacy",
      message: `${o.patient.fullName}'s ${o.drugName} order has waited ${minutes} min for pharmacist review.`,
      ownerRole: "PHARMACIST",
      createdAt: o.orderedAt.toISOString(),
    });
  }

  const heldOrClarification = await prisma.medicationOrder.findMany({
    where: { status: "HELD", encounter: { facilityId } },
    include: { patient: true, verifications: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  for (const o of heldOrClarification) {
    const v = o.verifications[0];
    if (v?.decision !== "CLARIFICATION_REQUESTED") continue;
    alerts.push({
      id: `pharmacy-clarification-${o.id}`,
      severity: "watch",
      department: "Pharmacy",
      message: `Pharmacist requested clarification on ${o.patient.fullName}'s ${o.drugName} order: ${v.reason ?? ""}`,
      ownerRole: "DOCTOR",
      createdAt: v.createdAt.toISOString(),
    });
  }

  const severityOrder = { critical: 0, watch: 1, info: 2 };
  return alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
}
