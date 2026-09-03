import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { mapToDiagnosticStatus } from "@/lib/hospital/diagnosticsSnapshot";

/**
 * Unified Diagnostics worklist (brief §4-5, §10, §12, §18) — composes the
 * SAME underlying queries src/app/api/hospital/orders/lab/worklist/route.ts
 * and .../orders/imaging/worklist/route.ts already run (not reinvented
 * logic), tags every row with diagnosticType + a shared presentation
 * status (mapToDiagnosticStatus — never replaces the real state machines),
 * and applies cross-domain filtering (type/priority/status/q) at the
 * presentation layer. This is the entry point for /hospital-os/diagnostics;
 * the dedicated /hospital-os/lab and /hospital-os/radiology worklists keep
 * their own richer per-domain action surface.
 *
 * Performance note (brief §21): `q` filtering happens in-memory after a
 * bounded fetch (each bucket query already scoped by facility+status,
 * mirroring the two per-domain worklists' existing indexed queries). At
 * Postgres/production scale, `q` should move into the Prisma `where`
 * clauses (patient.fullName/uhid `contains`, accessionNumber `contains`)
 * rather than filtering post-fetch — documented in
 * docs/PHASE_4_DIAGNOSTICS_ARCHITECTURE.md.
 */

interface UnifiedItem {
  id: string;
  diagnosticType: "LAB" | "RADIOLOGY";
  sourceOrderId: string;
  title: string;
  patientId: string;
  patientName: string;
  uhid: string;
  priority: string;
  status: string;
  ageMinutes: number | null;
  isCritical: boolean;
}

interface CriticalItem {
  id: string;
  diagnosticType: "LAB" | "RADIOLOGY";
  patientId: string;
  patientName: string;
  encounterId: string;
  sourceOrderId: string;
  severity: "critical";
  summary: string;
  createdAt: string;
  acknowledgedByStaffId: string | null;
  acknowledgedAt: string | null;
}

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    // Milestone E hardening — see the identical rationale in orders/lab/route.ts.
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const typeFilter = (searchParams.get("type") ?? "ALL").toUpperCase();
    const priorityFilter = searchParams.get("priority");
    const statusFilter = searchParams.get("status");
    const q = searchParams.get("q")?.trim().toLowerCase();

    const specimenInclude = { labOrder: { include: { patient: true, encounter: true } } } as const;
    const imagingOrderInclude = { patient: true, encounter: true } as const;

    const [
      pendingCollection, pendingReceipt, pendingAcceptance, rejectedAwaitingRecollection, pendingResult, labPendingVerification, labCritical,
      pendingScheduling, scheduledAwaitingArrival, readyForImaging, inProgress, pendingReport, imagingPendingVerification, imagingCritical,
    ] = await Promise.all([
      prisma.specimen.findMany({ where: { facilityId, status: "COLLECTION_PENDING" }, include: specimenInclude, orderBy: { createdAt: "asc" }, take: 100 }),
      prisma.specimen.findMany({ where: { facilityId, status: "COLLECTED" }, include: specimenInclude, orderBy: { collectedAt: "asc" }, take: 100 }),
      prisma.specimen.findMany({ where: { facilityId, status: "RECEIVED" }, include: specimenInclude, orderBy: { receivedAt: "asc" }, take: 100 }),
      prisma.specimen.findMany({ where: { facilityId, status: "REJECTED", recollections: { none: {} } }, include: specimenInclude, orderBy: { rejectedAt: "asc" }, take: 100 }),
      prisma.specimen.findMany({ where: { facilityId, status: "ACCEPTED" }, include: specimenInclude, orderBy: { acceptedAt: "asc" }, take: 100 }),
      prisma.labResult.findMany({ where: { status: "ENTERED", isCurrent: true, labOrder: { encounter: { facilityId } } }, include: { labOrder: { include: { patient: true, encounter: true } } }, orderBy: { resultedAt: "asc" }, take: 100 }),
      prisma.labResult.findMany({ where: { isCritical: true, acknowledgedAt: null, isCurrent: true, labOrder: { encounter: { facilityId } } }, include: { labOrder: { include: { patient: true, encounter: true } } }, orderBy: { resultedAt: "asc" }, take: 100 }),
      prisma.imagingOrder.findMany({ where: { encounter: { facilityId }, status: "ORDERED" }, include: imagingOrderInclude, orderBy: { orderedAt: "asc" }, take: 100 }),
      prisma.imagingStudy.findMany({ where: { facilityId, status: "SCHEDULED" }, include: { imagingOrder: { include: imagingOrderInclude } }, orderBy: { scheduledAt: "asc" }, take: 100 }),
      prisma.imagingStudy.findMany({ where: { facilityId, status: "ARRIVED" }, include: { imagingOrder: { include: imagingOrderInclude } }, orderBy: { arrivedAt: "asc" }, take: 100 }),
      prisma.imagingStudy.findMany({ where: { facilityId, status: "IN_PROGRESS" }, include: { imagingOrder: { include: imagingOrderInclude } }, orderBy: { startedAt: "asc" }, take: 100 }),
      prisma.imagingOrder.findMany({ where: { encounter: { facilityId }, status: "ACQUIRED" }, include: imagingOrderInclude, orderBy: { orderedAt: "asc" }, take: 100 }),
      prisma.imagingReport.findMany({ where: { status: "ENTERED", isCurrent: true, imagingOrder: { encounter: { facilityId } } }, include: { imagingOrder: { include: imagingOrderInclude } }, orderBy: { reportedAt: "asc" }, take: 100 }),
      prisma.imagingReport.findMany({ where: { isCritical: true, acknowledgedAt: null, isCurrent: true, imagingOrder: { encounter: { facilityId } } }, include: { imagingOrder: { include: imagingOrderInclude } }, orderBy: { reportedAt: "asc" }, take: 100 }),
    ]);

    const now = Date.now();
    const ageMinutes = (t: Date | null | undefined) => (t ? Math.round((now - t.getTime()) / 60000) : null);

    const items: UnifiedItem[] = [
      ...pendingCollection.map((s) => ({ id: `specimen-${s.id}`, diagnosticType: "LAB" as const, sourceOrderId: s.labOrder.id, title: s.labOrder.testName, patientId: s.labOrder.patient.id, patientName: s.labOrder.patient.fullName, uhid: s.labOrder.patient.uhid, priority: s.labOrder.priority, status: mapToDiagnosticStatus({ domain: "LAB", orderStatus: "ORDERED" }), ageMinutes: ageMinutes(s.createdAt), isCritical: false })),
      // Rejected specimens awaiting recollection (brief §5 parity with the
      // dedicated Lab worklist's 7 buckets) — diagnostically equivalent to
      // "awaiting a fresh specimen", same shared status as pendingCollection.
      ...rejectedAwaitingRecollection.map((s) => ({ id: `specimen-${s.id}`, diagnosticType: "LAB" as const, sourceOrderId: s.labOrder.id, title: s.labOrder.testName, patientId: s.labOrder.patient.id, patientName: s.labOrder.patient.fullName, uhid: s.labOrder.patient.uhid, priority: s.labOrder.priority, status: mapToDiagnosticStatus({ domain: "LAB", orderStatus: "ORDERED" }), ageMinutes: ageMinutes(s.rejectedAt), isCritical: false })),
      ...pendingReceipt.map((s) => ({ id: `specimen-${s.id}`, diagnosticType: "LAB" as const, sourceOrderId: s.labOrder.id, title: s.labOrder.testName, patientId: s.labOrder.patient.id, patientName: s.labOrder.patient.fullName, uhid: s.labOrder.patient.uhid, priority: s.labOrder.priority, status: mapToDiagnosticStatus({ domain: "LAB", orderStatus: "COLLECTED" }), ageMinutes: ageMinutes(s.collectedAt), isCritical: false })),
      ...pendingAcceptance.map((s) => ({ id: `specimen-${s.id}`, diagnosticType: "LAB" as const, sourceOrderId: s.labOrder.id, title: s.labOrder.testName, patientId: s.labOrder.patient.id, patientName: s.labOrder.patient.fullName, uhid: s.labOrder.patient.uhid, priority: s.labOrder.priority, status: mapToDiagnosticStatus({ domain: "LAB", orderStatus: "COLLECTED" }), ageMinutes: ageMinutes(s.receivedAt), isCritical: false })),
      ...pendingResult.map((s) => ({ id: `specimen-${s.id}`, diagnosticType: "LAB" as const, sourceOrderId: s.labOrder.id, title: s.labOrder.testName, patientId: s.labOrder.patient.id, patientName: s.labOrder.patient.fullName, uhid: s.labOrder.patient.uhid, priority: s.labOrder.priority, status: mapToDiagnosticStatus({ domain: "LAB", orderStatus: "IN_PROGRESS" }), ageMinutes: ageMinutes(s.acceptedAt), isCritical: false })),
      ...labPendingVerification.map((r) => ({ id: `labresult-${r.id}`, diagnosticType: "LAB" as const, sourceOrderId: r.labOrder.id, title: r.labOrder.testName, patientId: r.labOrder.patient.id, patientName: r.labOrder.patient.fullName, uhid: r.labOrder.patient.uhid, priority: r.labOrder.priority, status: mapToDiagnosticStatus({ domain: "LAB", orderStatus: "RESULTED", resultStatus: "ENTERED" }), ageMinutes: ageMinutes(r.resultedAt), isCritical: r.isCritical })),
      ...labCritical.map((r) => ({ id: `labresult-${r.id}`, diagnosticType: "LAB" as const, sourceOrderId: r.labOrder.id, title: r.labOrder.testName, patientId: r.labOrder.patient.id, patientName: r.labOrder.patient.fullName, uhid: r.labOrder.patient.uhid, priority: r.labOrder.priority, status: "CRITICAL" as const, ageMinutes: ageMinutes(r.resultedAt), isCritical: true })),
      ...pendingScheduling.map((o) => ({ id: `imgorder-${o.id}`, diagnosticType: "RADIOLOGY" as const, sourceOrderId: o.id, title: o.studyDescription, patientId: o.patient.id, patientName: o.patient.fullName, uhid: o.patient.uhid, priority: o.priority, status: mapToDiagnosticStatus({ domain: "RADIOLOGY", orderStatus: "ORDERED" }), ageMinutes: ageMinutes(o.orderedAt), isCritical: false })),
      ...scheduledAwaitingArrival.map((s) => ({ id: `study-${s.id}`, diagnosticType: "RADIOLOGY" as const, sourceOrderId: s.imagingOrder.id, title: s.imagingOrder.studyDescription, patientId: s.imagingOrder.patient.id, patientName: s.imagingOrder.patient.fullName, uhid: s.imagingOrder.patient.uhid, priority: s.imagingOrder.priority, status: mapToDiagnosticStatus({ domain: "RADIOLOGY", orderStatus: "SCHEDULED", subStatus: "SCHEDULED" }), ageMinutes: ageMinutes(s.scheduledAt), isCritical: false })),
      ...readyForImaging.map((s) => ({ id: `study-${s.id}`, diagnosticType: "RADIOLOGY" as const, sourceOrderId: s.imagingOrder.id, title: s.imagingOrder.studyDescription, patientId: s.imagingOrder.patient.id, patientName: s.imagingOrder.patient.fullName, uhid: s.imagingOrder.patient.uhid, priority: s.imagingOrder.priority, status: mapToDiagnosticStatus({ domain: "RADIOLOGY", orderStatus: "SCHEDULED", subStatus: "ARRIVED" }), ageMinutes: ageMinutes(s.arrivedAt), isCritical: false })),
      ...inProgress.map((s) => ({ id: `study-${s.id}`, diagnosticType: "RADIOLOGY" as const, sourceOrderId: s.imagingOrder.id, title: s.imagingOrder.studyDescription, patientId: s.imagingOrder.patient.id, patientName: s.imagingOrder.patient.fullName, uhid: s.imagingOrder.patient.uhid, priority: s.imagingOrder.priority, status: mapToDiagnosticStatus({ domain: "RADIOLOGY", orderStatus: "SCHEDULED", subStatus: "IN_PROGRESS" }), ageMinutes: ageMinutes(s.startedAt), isCritical: false })),
      ...pendingReport.map((o) => ({ id: `imgorder-${o.id}`, diagnosticType: "RADIOLOGY" as const, sourceOrderId: o.id, title: o.studyDescription, patientId: o.patient.id, patientName: o.patient.fullName, uhid: o.patient.uhid, priority: o.priority, status: mapToDiagnosticStatus({ domain: "RADIOLOGY", orderStatus: "ACQUIRED" }), ageMinutes: ageMinutes(o.orderedAt), isCritical: false })),
      ...imagingPendingVerification.map((r) => ({ id: `imgreport-${r.id}`, diagnosticType: "RADIOLOGY" as const, sourceOrderId: r.imagingOrder.id, title: r.imagingOrder.studyDescription, patientId: r.imagingOrder.patient.id, patientName: r.imagingOrder.patient.fullName, uhid: r.imagingOrder.patient.uhid, priority: r.imagingOrder.priority, status: mapToDiagnosticStatus({ domain: "RADIOLOGY", orderStatus: "REPORTED", resultStatus: "ENTERED" }), ageMinutes: ageMinutes(r.reportedAt), isCritical: r.isCritical })),
      ...imagingCritical.map((r) => ({ id: `imgreport-${r.id}`, diagnosticType: "RADIOLOGY" as const, sourceOrderId: r.imagingOrder.id, title: r.imagingOrder.studyDescription, patientId: r.imagingOrder.patient.id, patientName: r.imagingOrder.patient.fullName, uhid: r.imagingOrder.patient.uhid, priority: r.imagingOrder.priority, status: "CRITICAL" as const, ageMinutes: ageMinutes(r.reportedAt), isCritical: true })),
    ];

    const criticalItems: CriticalItem[] = [
      ...labCritical.map((r) => ({
        id: r.id, diagnosticType: "LAB" as const, patientId: r.labOrder.patient.id, patientName: r.labOrder.patient.fullName,
        encounterId: r.labOrder.encounter.id, sourceOrderId: r.labOrder.id, severity: "critical" as const,
        summary: `${r.labOrder.testName}: ${r.value} ${r.unit ?? ""}`.trim(), createdAt: r.resultedAt.toISOString(),
        acknowledgedByStaffId: r.acknowledgedByStaffId, acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
      })),
      ...imagingCritical.map((r) => ({
        id: r.id, diagnosticType: "RADIOLOGY" as const, patientId: r.imagingOrder.patient.id, patientName: r.imagingOrder.patient.fullName,
        encounterId: r.imagingOrder.encounter.id, sourceOrderId: r.imagingOrder.id, severity: "critical" as const,
        summary: `${r.imagingOrder.modality}: ${r.impression}`, createdAt: r.reportedAt.toISOString(),
        acknowledgedByStaffId: r.acknowledgedByStaffId, acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
      })),
    ];

    let filtered = items;
    if (typeFilter === "LAB" || typeFilter === "RADIOLOGY") filtered = filtered.filter((i) => i.diagnosticType === typeFilter);
    if (priorityFilter) filtered = filtered.filter((i) => i.priority === priorityFilter);
    if (statusFilter) filtered = filtered.filter((i) => i.status === statusFilter);
    if (q) filtered = filtered.filter((i) => i.patientName.toLowerCase().includes(q) || i.uhid.toLowerCase().includes(q) || i.title.toLowerCase().includes(q));

    // TAT foundation (brief §12) — averaged from the same fetched buckets,
    // read-time only, never persisted/fabricated.
    const avg = (nums: number[]) => (nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null);
    const minutesBetween = (from: Date | null | undefined, to: Date | null | undefined): number | null => (from && to ? (to.getTime() - from.getTime()) / 60000 : null);
    const isNumber = (n: number | null): n is number => n !== null;
    const tat = {
      avgLabOrderToCollectionMinutes: avg(pendingReceipt.concat(pendingAcceptance, pendingResult).map((s) => minutesBetween(s.labOrder.orderedAt, s.collectedAt)).filter(isNumber)),
      avgImagingOrderToStudyCompletionMinutes: avg(inProgress.map((s) => minutesBetween(s.imagingOrder.orderedAt, s.startedAt)).filter(isNumber)),
    };

    return {
      items: filtered.sort((a, b) => (b.ageMinutes ?? 0) - (a.ageMinutes ?? 0)),
      criticalItems,
      tat,
      counts: {
        total: items.length,
        lab: items.filter((i) => i.diagnosticType === "LAB").length,
        radiology: items.filter((i) => i.diagnosticType === "RADIOLOGY").length,
        critical: items.filter((i) => i.isCritical).length,
      },
    };
  });
}
