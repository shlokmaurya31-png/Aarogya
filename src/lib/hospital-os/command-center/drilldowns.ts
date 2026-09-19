import { prisma } from "@/lib/db";
import type { FacilityContext } from "@/lib/auth/hospitalRbac";
import { BadRequestError, ForbiddenError } from "@/lib/auth/rbac";
import { roleHasPermission } from "@/lib/auth/permissions";
import { canSeeClinicalDetail } from "./authz";

/**
 * Phase D10 — bounded, authorized drill-downs. Each is facility-scoped (from the D1
 * FacilityContext, never client input), paginated (max 50), and privacy-aware: patient
 * identity is included only for clinically-authorized viewers; financial drill-downs
 * require `billing:view`. This is not a general-purpose data API — only the known kinds
 * are served.
 */

const TAKE = 50;
export const DRILLDOWN_KINDS = [
  "ward-occupancy", "blocked-beds", "icu-beds", "ed-queue", "ot-delayed",
  "discharge-blockers", "lab-breaches", "radiology-breaches", "open-invoices", "claims-denied",
] as const;
export type DrillKind = (typeof DRILLDOWN_KINDS)[number];

export function isDrillKind(k: string): k is DrillKind {
  return (DRILLDOWN_KINDS as readonly string[]).includes(k);
}

export async function getDrillDown(fctx: FacilityContext, kind: string, params: Record<string, string> = {}) {
  if (!isDrillKind(kind)) throw new BadRequestError("Unknown drill-down.");
  const f = fctx.facilityId;
  const clinical = canSeeClinicalDetail(fctx.session);
  const financial = roleHasPermission(fctx.session.role, "billing:view");
  const asOf = new Date().toISOString();

  switch (kind) {
    case "ward-occupancy": {
      const beds = await prisma.bed.findMany({ where: { facilityId: f }, select: { status: true, ward: { select: { name: true, wardType: true } } } });
      const map = new Map<string, { ward: string; wardType: string; total: number; occupied: number; available: number }>();
      for (const b of beds) {
        const k = b.ward.name;
        const acc = map.get(k) ?? { ward: k, wardType: b.ward.wardType, total: 0, occupied: 0, available: 0 };
        acc.total++; if (b.status === "OCCUPIED") acc.occupied++; if (b.status === "AVAILABLE") acc.available++;
        map.set(k, acc);
      }
      return { kind, asOf, rows: [...map.values()].sort((a, b) => b.occupied / b.total - a.occupied / a.total) };
    }
    case "blocked-beds": {
      const rows = await prisma.bed.findMany({ where: { facilityId: f, status: { in: ["BLOCKED", "MAINTENANCE"] } }, select: { label: true, status: true, ward: { select: { name: true } } }, take: TAKE });
      return { kind, asOf, rows: rows.map((r) => ({ bed: r.label, ward: r.ward.name, status: r.status })) };
    }
    case "icu-beds": {
      const rows = await prisma.bed.groupBy({ by: ["status"], where: { facilityId: f, OR: [{ icuCapable: true }, { icuUnitId: { not: null } }] }, _count: true });
      return { kind, asOf, rows: rows.map((r) => ({ status: r.status, count: r._count })) };
    }
    case "ed-queue": {
      const rows = await prisma.queueEntry.findMany({ where: { facilityId: f, queueType: "ED", status: "WAITING" }, orderBy: { enteredAt: "asc" }, take: TAKE, select: { enteredAt: true, priorityScore: true, priorityReason: true, patientId: clinical } });
      return { kind, asOf, rows: rows.map((r) => ({ waitedMin: Math.round((Date.now() - r.enteredAt.getTime()) / 60000), priorityScore: r.priorityScore, reason: r.priorityReason, ...(clinical ? { patientId: r.patientId } : {}) })) };
    }
    case "ot-delayed": {
      const rows = await prisma.surgerySchedule.findMany({ where: { facilityId: f, status: "SCHEDULED", startAt: { lt: new Date() }, surgery: { status: { in: ["SCHEDULED", "APPROVED", "REVIEWED"] } } }, orderBy: { startAt: "asc" }, take: TAKE, select: { startAt: true, surgery: { select: { procedureName: true, urgency: true, status: true, patientId: clinical } } } });
      return { kind, asOf, rows: rows.map((r) => ({ scheduledStart: r.startAt.toISOString(), delayedMin: Math.round((Date.now() - r.startAt.getTime()) / 60000), procedure: r.surgery.procedureName, urgency: r.surgery.urgency, status: r.surgery.status, ...(clinical ? { patientId: r.surgery.patientId } : {}) })) };
    }
    case "discharge-blockers": {
      const owner = params.owner;
      const flag = owner === "billing" ? { billingReady: false } : owner === "insurance" ? { insuranceReady: false } : owner === "pharmacy" ? { pharmacyReady: false } : owner === "documentation" ? { documentationReady: false } : owner === "transport" ? { transportReady: false } : { OR: [{ billingReady: false }, { insuranceReady: false }, { pharmacyReady: false }, { documentationReady: false }, { transportReady: false }] };
      const rows = await prisma.discharge.findMany({ where: { dischargedAt: null, clinicallyReady: true, admission: { encounter: { facilityId: f } }, ...flag }, orderBy: { initiatedAt: "asc" }, take: TAKE, select: { initiatedAt: true, billingReady: true, insuranceReady: true, pharmacyReady: true, documentationReady: true, transportReady: true, admission: { select: { encounter: { select: { patientId: clinical } } } } } });
      return { kind, asOf, rows: rows.map((r) => ({ ageHours: Math.round((Date.now() - r.initiatedAt.getTime()) / 3_600_000), pending: [!r.billingReady && "Billing", !r.insuranceReady && "Insurance", !r.pharmacyReady && "Pharmacy", !r.documentationReady && "Documentation", !r.transportReady && "Transport"].filter(Boolean), ...(clinical ? { patientId: r.admission.encounter.patientId } : {}) })) };
    }
    case "lab-breaches": {
      const warn = 240;
      const rows = await prisma.labResult.findMany({ where: { isCurrent: true, isCritical: false, resultedAt: { gte: new Date(Date.now() - 86_400_000) }, labOrder: { encounter: { facilityId: f } } }, orderBy: { resultedAt: "desc" }, take: 200, select: { resultedAt: true, labOrder: { select: { orderedAt: true, priority: true, patientId: clinical } } } });
      const breached = rows.map((r) => ({ tatMin: Math.round((r.resultedAt.getTime() - r.labOrder.orderedAt.getTime()) / 60000), priority: r.labOrder.priority, ...(clinical ? { patientId: r.labOrder.patientId } : {}) })).filter((r) => r.tatMin > warn).slice(0, TAKE);
      return { kind, asOf, rows: breached };
    }
    case "radiology-breaches": {
      const warn = 480;
      const rows = await prisma.imagingReport.findMany({ where: { isCurrent: true, reportedAt: { gte: new Date(Date.now() - 86_400_000) }, imagingOrder: { encounter: { facilityId: f } } }, orderBy: { reportedAt: "desc" }, take: 200, select: { reportedAt: true, imagingOrder: { select: { orderedAt: true, priority: true, patientId: clinical } } } });
      const breached = rows.map((r) => ({ tatMin: Math.round((r.reportedAt.getTime() - r.imagingOrder.orderedAt.getTime()) / 60000), priority: r.imagingOrder.priority, ...(clinical ? { patientId: r.imagingOrder.patientId } : {}) })).filter((r) => r.tatMin > warn).slice(0, TAKE);
      return { kind, asOf, rows: breached };
    }
    case "open-invoices": {
      if (!financial) throw new ForbiddenError("billing:view");
      const rows = await prisma.invoice.findMany({ where: { facilityId: f, status: { in: ["ISSUED", "PARTIALLY_PAID"] } }, orderBy: { issuedAt: "asc" }, take: TAKE, select: { invoiceNumber: true, totalMinor: true, allocatedMinor: true, currency: true, issuedAt: true } });
      return { kind, asOf, rows: rows.map((r) => ({ invoiceNumber: r.invoiceNumber, outstandingMinor: Math.max(0, r.totalMinor - r.allocatedMinor), currency: r.currency, issuedAt: r.issuedAt?.toISOString() ?? null })) };
    }
    case "claims-denied": {
      if (!financial) throw new ForbiddenError("billing:view");
      const rows = await prisma.claim.findMany({ where: { facilityId: f, status: { in: ["REJECTED", "PARTIALLY_APPROVED"] } }, orderBy: { decidedAt: "desc" }, take: TAKE, select: { claimNumber: true, status: true, denialReason: true, submittedAmountMinor: true, approvedAmountMinor: true } });
      return { kind, asOf, rows };
    }
    default:
      throw new BadRequestError("Unknown drill-down.");
  }
}
