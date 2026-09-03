import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { getDiagnosticsOperationalCounts } from "@/lib/hospital/diagnosticsSnapshot";

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
      unsignedNotes,
      medsPendingAttention,
      consultRequests,
      dischargeCandidates,
      followUpTasks,
      pendingHandoffs,
      diagnostics,
    ] = await Promise.all([
      prisma.queueEntry.count({ where: { facilityId, status: "WAITING", ...(staffId ? { practitionerStaffId: staffId } : {}) } }),
      prisma.queueEntry.count({ where: { facilityId, status: "IN_SERVICE", ...(staffId ? { practitionerStaffId: staffId } : {}) } }),
      prisma.encounter.count({ where: { facilityId, status: "ADMITTED", ...(staffId ? { attendingStaffId: staffId } : {}) } }),
      prisma.clinicalNote.count({ where: { status: "DRAFT", encounter: { facilityId }, ...(staffId ? { authorStaffId: staffId } : {}) } }),
      prisma.medicationOrder.count({ where: { encounter: { facilityId }, status: { in: ["HELD", "REJECTED"] } } }),
      prisma.referral.count({ where: { encounter: { facilityId }, status: { in: ["PLACED", "ACKNOWLEDGED"] }, ...(staffId ? { toStaffId: staffId } : {}) } }),
      prisma.discharge.count({ where: { dischargedAt: null, clinicallyReady: true, admission: { encounter: { facilityId } } } }),
      prisma.task.count({ where: { facilityId, type: "FOLLOW_UP", status: { in: ["OPEN", "ASSIGNED"] }, ...(staffId ? { ownerStaffId: staffId } : {}) } }),
      prisma.clinicalHandoff.count({ where: { facilityId, status: "PENDING", ...(staffId ? { toStaffId: staffId } : {}) } }),
      // Phase 4 Milestone D (brief §3) — de-duplicated diagnostics
      // aggregate, same shared helper commandCenter.ts now uses. This
      // route previously ran its own copy of these 4 queries.
      getDiagnosticsOperationalCounts(facilityId),
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
      pendingResults: { lab: diagnostics.pending.lab, imaging: diagnostics.pending.imaging },
      criticalResults: { lab: diagnostics.safety.criticalLab, imaging: diagnostics.safety.criticalImaging },
      unsignedNotes,
      medsPendingAttention,
      consultRequests,
      dischargeCandidates,
      followUpTasks,
      pendingHandoffs,
    };
  });
}
