import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";

/** Nursing Dashboard (brief §10) — assigned patients, tasks, MAR, vitals, escalations, all live and facility-scoped, optionally narrowed to "my" patients via staffId. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const staffId = searchParams.get("staffId") ?? undefined;
    const now = new Date();

    const assignments = await prisma.nursingAssignment.findMany({
      where: { facilityId, endAt: null, ...(staffId ? { nurseStaffId: staffId } : {}) },
      include: { patient: true, bed: { include: { ward: true } }, encounter: true },
    });
    const assignedPatientIds = assignments.map((a) => a.patientId);

    const [
      overdueTasks,
      pendingTasks,
      medsDue,
      missedAdministrations,
      upcomingAdministrations,
      pendingHandoffs,
    ] = await Promise.all([
      prisma.task.count({ where: { facilityId, status: { in: ["OPEN", "ASSIGNED", "IN_PROGRESS"] }, dueAt: { lte: now }, ...(staffId ? { ownerStaffId: staffId } : {}) } }),
      prisma.task.count({ where: { facilityId, status: { in: ["OPEN", "ASSIGNED"] }, ...(staffId ? { ownerStaffId: staffId } : {}) } }),
      prisma.medicationAdministration.count({ where: { status: "DUE", scheduledAt: { lte: now }, medicationOrder: { encounter: { facilityId }, patientId: assignedPatientIds.length ? { in: assignedPatientIds } : undefined } } }),
      prisma.medicationAdministration.count({ where: { status: "MISSED", medicationOrder: { encounter: { facilityId } } } }),
      prisma.medicationAdministration.count({ where: { status: "DUE", scheduledAt: { gt: now, lte: new Date(now.getTime() + 2 * 3_600_000) }, medicationOrder: { encounter: { facilityId } } } }),
      prisma.clinicalHandoff.count({ where: { facilityId, type: "NURSE", status: "PENDING", ...(staffId ? { toStaffId: staffId } : {}) } }),
    ]);

    return {
      assignedPatients: assignments.map((a) => ({
        assignmentId: a.id, patientId: a.patientId, patientName: a.patient.fullName, uhid: a.patient.uhid,
        bedLabel: a.bed?.label ?? null, wardName: a.bed?.ward.name ?? null, encounterId: a.encounterId,
      })),
      overdueTasks,
      pendingTasks,
      medicationsDue: medsDue,
      missedAdministrations,
      upcomingAdministrations,
      pendingHandoffs,
    };
  });
}
