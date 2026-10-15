import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { isStaffInFacility } from "@/lib/auth/staffFacility";

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
    const d = parsed.data;

    const staff = await prisma.hospitalStaffProfile.findUnique({ where: { id: d.staffId } });
    if (!staff || !(await isStaffInFacility(prisma, staff.id, facilityId))) throw new NotFoundError("Doctor not found.");

    if (d.type === "CLINIC_SESSION") {
      if (d.dayOfWeek === undefined && !d.specificDate) throw new BadRequestError("Either dayOfWeek or specificDate is required.");
      if (d.startMinute === undefined || d.endMinute === undefined || d.endMinute <= d.startMinute) {
        throw new BadRequestError("A clinic session needs startMinute and a later endMinute.");
      }
      const block = await prisma.doctorScheduleBlock.create({
        data: {
          staffId: d.staffId,
          facilityId,
          departmentId: d.departmentId,
          dayOfWeek: d.dayOfWeek,
          specificDate: d.specificDate ? new Date(d.specificDate) : undefined,
          startMinute: d.startMinute,
          endMinute: d.endMinute,
          slotDurationMinutes: d.slotDurationMinutes,
          maxConcurrentAppointments: d.maxConcurrentAppointments,
          roomLabel: d.roomLabel,
        },
      });
      return { block };
    }

    if (!d.specificDate) throw new BadRequestError("Leave, holidays and blocked time need a specificDate.");
    const day = new Date(d.specificDate);
    if (Number.isNaN(day.getTime())) throw new BadRequestError("specificDate is not a valid date.");
    day.setHours(0, 0, 0, 0);
    const startAt = new Date(day.getTime() + (d.startMinute ?? 0) * 60_000);
    const endAt = new Date(day.getTime() + (d.endMinute ?? 1440) * 60_000);
    if (endAt <= startAt) throw new BadRequestError("endMinute must be after startMinute.");
    const absence = await prisma.staffAbsence.create({
      data: { facilityId, staffId: d.staffId, kind: d.type, startAt, endAt, reason: d.reason, recordedByStaffId: actor?.id },
    });
    return { absence };
  });
}
