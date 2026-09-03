import { prisma } from "@/lib/db";

/**
 * Shared presentation-layer status (brief §5) — a read-only view over the
 * REAL domain state machines (LabOrderStatus/SpecimenStatus/
 * LabResultStatus and ImagingOrderStatus/ImagingStudyStatus/
 * ImagingReportStatus, all unchanged). Never written back, never a
 * replacement for the domain enums — purely how the unified Diagnostics
 * worklist and dashboards *display* an item.
 */
export type DiagnosticStatus =
  | "ORDERED"
  | "SCHEDULED"
  | "IN_PROGRESS"
  | "AWAITING_RESULT"
  | "AWAITING_VERIFICATION"
  | "COMPLETED"
  | "CRITICAL"
  | "CANCELLED";

/**
 * Maps a Lab or Radiology item's real state into the shared presentation
 * status. `isCritical` (an unacknowledged critical result/finding) always
 * wins regardless of underlying order/sub-status — a verified-but-critical
 * report is still CRITICAL until acknowledged, matching how alertEngine.ts
 * already treats these two facts as independent axes.
 */
export function mapToDiagnosticStatus(input: {
  domain: "LAB" | "RADIOLOGY";
  orderStatus: string;
  subStatus?: string | null;
  resultStatus?: string | null;
  isCritical?: boolean;
}): DiagnosticStatus {
  if (input.isCritical) return "CRITICAL";
  if (input.orderStatus === "CANCELLED") return "CANCELLED";

  if (input.domain === "LAB") {
    switch (input.orderStatus) {
      case "ORDERED":
        return "ORDERED";
      case "COLLECTED":
        return "IN_PROGRESS";
      case "IN_PROGRESS":
        return "AWAITING_RESULT";
      case "RESULTED":
        return input.resultStatus === "ENTERED" ? "AWAITING_VERIFICATION" : "COMPLETED";
      default:
        return "ORDERED";
    }
  }

  // RADIOLOGY
  switch (input.orderStatus) {
    case "ORDERED":
      return "ORDERED";
    case "SCHEDULED":
      return input.subStatus === "ARRIVED" || input.subStatus === "IN_PROGRESS" ? "IN_PROGRESS" : "SCHEDULED";
    case "ACQUIRED":
      return "AWAITING_RESULT";
    case "REPORTED":
      return input.resultStatus === "ENTERED" ? "AWAITING_VERIFICATION" : "COMPLETED";
    default:
      return "ORDERED";
  }
}

/**
 * De-duplicated volume/pending/critical diagnostics aggregate (brief §3) —
 * replaces the near-identical queries that were independently copy-pasted
 * between commandCenter.ts and doctor/dashboard/route.ts. Every number is
 * a live Prisma count, facility-scoped, same query shapes those two call
 * sites already used (not new logic, just de-duplicated).
 */
export async function getDiagnosticsOperationalCounts(facilityId: string) {
  const [
    labOrdersToday,
    imagingOrdersToday,
    pendingLabResults,
    pendingImagingResults,
    criticalLabResults,
    criticalImagingReports,
    specimensPendingCollection,
    specimensRejectedAwaitingRecollection,
    resultsPendingVerification,
    studiesPendingScheduling,
    studiesScheduledAwaitingArrival,
    reportsPendingVerification,
  ] = await Promise.all([
    prisma.labOrder.count({ where: { encounter: { facilityId } } }),
    prisma.imagingOrder.count({ where: { encounter: { facilityId } } }),
    prisma.labOrder.count({ where: { encounter: { facilityId }, status: { notIn: ["RESULTED", "CANCELLED"] } } }),
    prisma.imagingOrder.count({ where: { encounter: { facilityId }, status: { notIn: ["REPORTED", "CANCELLED"] } } }),
    prisma.labResult.count({ where: { isCritical: true, acknowledgedAt: null, isCurrent: true, labOrder: { encounter: { facilityId } } } }),
    prisma.imagingReport.count({ where: { isCritical: true, acknowledgedAt: null, isCurrent: true, imagingOrder: { encounter: { facilityId } } } }),
    prisma.specimen.count({ where: { facilityId, status: "COLLECTION_PENDING" } }),
    prisma.specimen.count({ where: { facilityId, status: "REJECTED", recollections: { none: {} } } }),
    prisma.labResult.count({ where: { status: "ENTERED", isCurrent: true, labOrder: { encounter: { facilityId } } } }),
    prisma.imagingOrder.count({ where: { encounter: { facilityId }, status: "ORDERED" } }),
    prisma.imagingStudy.count({ where: { facilityId, status: "SCHEDULED" } }),
    prisma.imagingReport.count({ where: { status: "ENTERED", isCurrent: true, imagingOrder: { encounter: { facilityId } } } }),
  ]);

  return {
    volume: { labOrders: labOrdersToday, imagingOrders: imagingOrdersToday },
    pending: {
      lab: pendingLabResults,
      imaging: pendingImagingResults,
      specimensPendingCollection,
      specimensRejectedAwaitingRecollection,
      resultsPendingVerification,
      studiesPendingScheduling,
      studiesScheduledAwaitingArrival,
      reportsPendingVerification,
    },
    safety: {
      criticalLab: criticalLabResults,
      criticalImaging: criticalImagingReports,
      totalUnacknowledgedCritical: criticalLabResults + criticalImagingReports,
    },
    risk: {
      rejectedSpecimensAwaitingRecollection: specimensRejectedAwaitingRecollection,
    },
  };
}
