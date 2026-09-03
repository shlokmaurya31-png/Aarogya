import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";

/**
 * Doctor Dashboard (brief §2) — every section a live, facility-scoped
 * query. `staffId` narrows "my" sections (queue, unsigned notes,
 * consults); the rest reflects the whole facility a doctor might round on.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const staffId = searchParams.get("staffId") ?? undefined;

    const [
      myQueueWaiting,
      myQueueInService,
      admittedPatients,
      pendingLabResults,
      pendingImagingResults,
      criticalLabResults,
      criticalImagingReports,
      unsignedNotes,
      medsPendingAttention,
      consultRequests,
      dischargeCandidates,
      followUpTasks,
      pendingHandoffs,
    ] = await Promise.all([
      prisma.queueEntry.count({ where: { facilityId, status: "WAITING", ...(staffId ? { practitionerStaffId: staffId } : {}) } }),
      prisma.queueEntry.count({ where: { facilityId, status: "IN_SERVICE", ...(staffId ? { practitionerStaffId: staffId } : {}) } }),
      prisma.encounter.count({ where: { facilityId, status: "ADMITTED", ...(staffId ? { attendingStaffId: staffId } : {}) } }),
      prisma.labOrder.count({ where: { encounter: { facilityId }, status: { notIn: ["RESULTED", "CANCELLED"] } } }),
      prisma.imagingOrder.count({ where: { encounter: { facilityId }, status: { notIn: ["REPORTED", "CANCELLED"] } } }),
      prisma.labResult.count({ where: { isCritical: true, acknowledgedAt: null, isCurrent: true, labOrder: { encounter: { facilityId } } } }),
      prisma.imagingReport.count({ where: { isCritical: true, acknowledgedAt: null, isCurrent: true, imagingOrder: { encounter: { facilityId } } } }),
      prisma.clinicalNote.count({ where: { status: "DRAFT", encounter: { facilityId }, ...(staffId ? { authorStaffId: staffId } : {}) } }),
      prisma.medicationOrder.count({ where: { encounter: { facilityId }, status: { in: ["HELD", "REJECTED"] } } }),
      prisma.referral.count({ where: { encounter: { facilityId }, status: { in: ["PLACED", "ACKNOWLEDGED"] }, ...(staffId ? { toStaffId: staffId } : {}) } }),
      prisma.discharge.count({ where: { dischargedAt: null, clinicallyReady: true, admission: { encounter: { facilityId } } } }),
      prisma.task.count({ where: { facilityId, type: "FOLLOW_UP", status: { in: ["OPEN", "ASSIGNED"] }, ...(staffId ? { ownerStaffId: staffId } : {}) } }),
      prisma.clinicalHandoff.count({ where: { facilityId, status: "PENDING", ...(staffId ? { toStaffId: staffId } : {}) } }),
    ]);

    const roundsList = await prisma.encounter.findMany({
      where: { facilityId, status: "ADMITTED", ...(staffId ? { attendingStaffId: staffId } : {}) },
      include: { patient: true, admission: { include: { bed: { include: { ward: true } } } } },
      orderBy: { registeredAt: "asc" },
      take: 30,
    });

    return {
      myQueue: { waiting: myQueueWaiting, inService: myQueueInService },
      admittedPatients,
      roundsList: roundsList.map((e) => ({
        encounterId: e.id, patientId: e.patient.id, patientName: e.patient.fullName, uhid: e.patient.uhid,
        bedLabel: e.admission?.bed.label ?? null, wardName: e.admission?.bed.ward.name ?? null,
      })),
      pendingResults: { lab: pendingLabResults, imaging: pendingImagingResults },
      criticalResults: { lab: criticalLabResults, imaging: criticalImagingReports },
      unsignedNotes,
      medsPendingAttention,
      consultRequests,
      dischargeCandidates,
      followUpTasks,
      pendingHandoffs,
    };
  });
}
