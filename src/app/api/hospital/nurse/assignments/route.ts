import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { assignNurse } from "@/lib/hospital/nursingAssignment";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const nurseStaffId = searchParams.get("nurseStaffId");
    const patientId = searchParams.get("patientId");
    const includeHistory = searchParams.get("history") === "true";

    const assignments = await prisma.nursingAssignment.findMany({
      where: {
        facilityId,
        ...(nurseStaffId ? { nurseStaffId } : {}),
        ...(patientId ? { patientId } : {}),
        ...(includeHistory ? {} : { endAt: null }),
      },
      include: { patient: true, nurse: { include: { user: true } }, bed: { include: { ward: true } } },
      orderBy: { startAt: "desc" },
      take: 200,
    });
    return { assignments };
  });
}

const AssignSchema = z.object({
  nurseStaffId: z.string(),
  patientId: z.string(),
  encounterId: z.string().optional(),
  bedId: z.string().optional(),
  departmentId: z.string().optional(),
  reason: z.string().optional(),
  facilityId: z.string().optional(),
});

/** Nurse-to-patient assignment (brief §11) — assigning a patient ends any prior open assignment (history preserved, never overwritten). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("nursing:assignment:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Assignment must be made by a staff account.");
    const parsed = AssignSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid assignment data.");

    const nurse = await prisma.hospitalStaffProfile.findUnique({ where: { id: parsed.data.nurseStaffId } });
    if (!nurse || nurse.facilityId !== facilityId) throw new NotFoundError("Nurse not found.");

    const assignment = await assignNurse({
      facilityId,
      departmentId: parsed.data.departmentId,
      nurseStaffId: parsed.data.nurseStaffId,
      patientId: parsed.data.patientId,
      encounterId: parsed.data.encounterId,
      bedId: parsed.data.bedId,
      reason: parsed.data.reason,
      assignedByStaffId: staff.id,
      byUserId: session.userId,
    });
    return { assignment };
  });
}
