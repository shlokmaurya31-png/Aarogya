import { createScheduleBlock } from "@/lib/hospital/scheduleBlocks";
import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";

/** Clinic sessions and absences (D7: leave/holiday/blocked time are StaffAbsence rows). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const staffId = searchParams.get("staffId");

    const [blocks, absences] = await Promise.all([
      prisma.doctorScheduleBlock.findMany({
        where: { facilityId, ...(staffId ? { staffId } : {}) },
        orderBy: [{ dayOfWeek: "asc" }, { startMinute: "asc" }, { id: "asc" }],
      }),
      prisma.staffAbsence.findMany({
        where: { facilityId, cancelledAt: null, ...(staffId ? { staffId } : {}), OR: [{ endAt: null }, { endAt: { gt: new Date() } }] },
        orderBy: [{ startAt: "asc" }, { id: "asc" }],
      }),
    ]);
    return { blocks, absences };
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

/**
 * Doctor scheduling foundation (brief §7). A CLINIC_SESSION is a
 * DoctorScheduleBlock; LEAVE, HOLIDAY and BLOCKED are recorded as a StaffAbsence
 * for the date (whole day, or startMinute–endMinute of it) — the one source
 * of leave that booking checks (D7).
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { facilityId, staff: actor } = await requireFacilityStaff("hospital:admin:manage", body?.facilityId);
    const parsed = BlockSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid schedule block data.");
    return createScheduleBlock({ ...parsed.data, facilityId, recordedByStaffId: actor?.id });
  });
}
