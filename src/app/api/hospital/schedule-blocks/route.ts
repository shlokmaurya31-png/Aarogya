import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const staffId = searchParams.get("staffId");

    const blocks = await prisma.doctorScheduleBlock.findMany({
      where: { facilityId, ...(staffId ? { staffId } : {}) },
      orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }],
    });
    return { blocks };
  });
}

const BlockSchema = z.object({
  staffId: z.string(),
  departmentId: z.string().optional(),
  type: z.enum(["CLINIC_SESSION", "BLOCKED", "LEAVE", "HOLIDAY"]),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  specificDate: z.string().optional(),
  startMinute: z.number().int().min(0).max(1439).optional(),
  endMinute: z.number().int().min(0).max(1440).optional(),
  slotDurationMinutes: z.number().int().min(5).max(180).optional(),
  maxConcurrentAppointments: z.number().int().min(1).max(20).optional(),
  roomLabel: z.string().optional(),
  reason: z.string().optional(),
  facilityId: z.string().optional(),
});

/** Doctor scheduling foundation (brief §7) — working hours/sessions/leave/holiday/block, no payroll/HR. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { facilityId } = await requireFacilityStaff("hospital:admin:manage", body?.facilityId);
    const parsed = BlockSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid schedule block data.");
    if (!parsed.data.dayOfWeek && !parsed.data.specificDate) throw new BadRequestError("Either dayOfWeek or specificDate is required.");

    const staff = await prisma.hospitalStaffProfile.findUnique({ where: { id: parsed.data.staffId } });
    if (!staff || staff.facilityId !== facilityId) throw new NotFoundError("Doctor not found.");

    const block = await prisma.doctorScheduleBlock.create({
      data: {
        staffId: parsed.data.staffId,
        facilityId,
        departmentId: parsed.data.departmentId,
        type: parsed.data.type,
        dayOfWeek: parsed.data.dayOfWeek,
        specificDate: parsed.data.specificDate ? new Date(parsed.data.specificDate) : undefined,
        startMinute: parsed.data.startMinute,
        endMinute: parsed.data.endMinute,
        slotDurationMinutes: parsed.data.slotDurationMinutes,
        maxConcurrentAppointments: parsed.data.maxConcurrentAppointments,
        roomLabel: parsed.data.roomLabel,
        reason: parsed.data.reason,
      },
    });
    return { block };
  });
}
