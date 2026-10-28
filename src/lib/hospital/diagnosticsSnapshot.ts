import { ImagingOrderStatus, LabOrderStatus } from "@prisma/client";
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
 * Flagship 1c: the open statuses as a list (every status but the two final
 * ones, so a new status is open until listed here), so the counts below can use
 * the status index: `status NOT IN (…)` through the encounter join was a full
 * scan of every order the facility ever had.
 */
const OPEN_LAB_ORDER = Object.values(LabOrderStatus).filter((s) => s !== "RESULTED" && s !== "CANCELLED");
const OPEN_IMAGING_ORDER = Object.values(ImagingOrderStatus).filter((s) => s !== "REPORTED" && s !== "CANCELLED");

/**
 * De-duplicated pending/critical diagnostics aggregate (brief §3) —
 * replaces the near-identical queries that were independently copy-pasted
 * between commandCenter.ts and doctor/dashboard/route.ts. Every number is
 * a live Prisma count, facility-scoped, same query shapes those two call
 * sites already used (not new logic, just de-duplicated).
 *
 * Flagship 1c: the two all-time order counts ("volume", named "today" but
 * counting every order ever) are gone: nothing read them, and they scanned
 * the whole order history on every dashboard load.
 */
export async function getDiagnosticsOperationalCounts(facilityId: string) {
  const [
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
    prisma.labOrder.count({ where: { encounter: { facilityId }, status: { in: OPEN_LAB_ORDER } } }),
    prisma.imagingOrder.count({ where: { encounter: { facilityId }, status: { in: OPEN_IMAGING_ORDER } } }),
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
