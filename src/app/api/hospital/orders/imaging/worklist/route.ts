import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";

/**
 * Radiology worklist (brief §9) — operational buckets by order/study/report
 * status, not a single flat list. TAT is derived from timestamp columns
 * already on ImagingStudy/ImagingReport at read time, matching Lab's
 * worklist and commandCenter.ts's "derive from timestamps" philosophy.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    // Milestone E hardening — see the identical rationale in orders/lab/route.ts.
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);

    const orderInclude = { patient: true, encounter: true } as const;

    const [pendingScheduling, scheduledAwaitingArrival, readyForImaging, inProgress, pendingReport, pendingVerification, criticalFindings] = await Promise.all([
      prisma.imagingOrder.findMany({ where: { encounter: { facilityId }, status: "ORDERED" }, include: orderInclude, orderBy: { orderedAt: "asc" } }),
      prisma.imagingStudy.findMany({ where: { facilityId, status: "SCHEDULED" }, include: { imagingOrder: { include: orderInclude } }, orderBy: { scheduledAt: "asc" } }),
      prisma.imagingStudy.findMany({ where: { facilityId, status: "ARRIVED" }, include: { imagingOrder: { include: orderInclude } }, orderBy: { arrivedAt: "asc" } }),
      prisma.imagingStudy.findMany({ where: { facilityId, status: "IN_PROGRESS" }, include: { imagingOrder: { include: orderInclude } }, orderBy: { startedAt: "asc" } }),
      prisma.imagingOrder.findMany({ where: { encounter: { facilityId }, status: "ACQUIRED" }, include: orderInclude, orderBy: { orderedAt: "asc" } }),
      prisma.imagingReport.findMany({
        where: { status: "ENTERED", isCurrent: true, imagingOrder: { encounter: { facilityId } } },
        include: { imagingOrder: { include: orderInclude } },
        orderBy: { reportedAt: "asc" },
      }),
      prisma.imagingReport.findMany({
        where: { isCritical: true, acknowledgedAt: null, isCurrent: true, imagingOrder: { encounter: { facilityId } } },
        include: { imagingOrder: { include: orderInclude } },
        orderBy: { reportedAt: "asc" },
      }),
    ]);

    const now = Date.now();
    const ageMinutes = (t: Date | null) => (t ? Math.round((now - t.getTime()) / 60000) : null);

    return {
      pendingScheduling: pendingScheduling.map((o) => ({ ...o, ageMinutes: ageMinutes(o.orderedAt) })),
      scheduledAwaitingArrival: scheduledAwaitingArrival.map((s) => ({ ...s, ageMinutes: ageMinutes(s.scheduledAt) })),
      readyForImaging: readyForImaging.map((s) => ({ ...s, ageMinutes: ageMinutes(s.arrivedAt) })),
      inProgress: inProgress.map((s) => ({ ...s, ageMinutes: ageMinutes(s.startedAt) })),
      pendingReport: pendingReport.map((o) => ({ ...o, ageMinutes: ageMinutes(o.orderedAt) })),
      pendingVerification: pendingVerification.map((r) => ({ ...r, ageMinutes: ageMinutes(r.reportedAt) })),
      criticalFindings: criticalFindings.map((r) => ({ ...r, ageMinutes: ageMinutes(r.reportedAt) })),
    };
  });
}
