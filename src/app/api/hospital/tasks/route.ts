import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

/**
 * Generic task foundation (brief §25). Medication-due/vitals-due tasks
 * remain their own computed views (/api/hospital/nurse/tasks) rather than
 * duplicating into this table — see docs/CLINICAL_CORE.md §4. This is for
 * every other task type: discharge prep, patient education, follow-up,
 * general.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("task:view", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status");
    const ownerStaffId = searchParams.get("ownerStaffId");

    const tasks = await prisma.task.findMany({
      where: {
        facilityId,
        ...(status ? { status } : { status: { notIn: ["COMPLETED", "CANCELLED"] } }),
        ...(ownerStaffId ? { ownerStaffId } : {}),
      },
      include: { patient: true, owner: { include: { user: true } }, department: true },
      orderBy: [{ priority: "desc" }, { dueAt: "asc" }],
      take: 100,
    });
    return { tasks };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("task:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Tasks must be created by a staff account.");

    const { title, type, description, priority, dueAt, patientId, encounterId, ownerStaffId, departmentId } = body ?? {};
    if (!title || !type) throw new BadRequestError("title and type are required.");

    const task = await prisma.task.create({
      data: {
        facilityId,
        departmentId,
        title,
        description,
        type,
        priority: priority ?? "ROUTINE",
        status: ownerStaffId ? "ASSIGNED" : "OPEN",
        dueAt: dueAt ? new Date(dueAt) : undefined,
        source: "manual",
        patientId,
        encounterId,
        ownerStaffId,
        createdByStaffId: staff.id,
      },
    });

    await recordAuditEvent("hospital.task.created", session.userId, { taskId: task.id, type });
    return { task };
  });
}
