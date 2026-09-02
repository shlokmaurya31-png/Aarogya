import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { bookAppointment, SlotConflictError } from "@/lib/hospital/appointment";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const doctorStaffId = searchParams.get("doctorStaffId");
    const date = searchParams.get("date"); // yyyy-mm-dd
    const status = searchParams.get("status");

    let dateFilter: { gte: Date; lt: Date } | undefined;
    if (date) {
      const start = new Date(`${date}T00:00:00`);
      dateFilter = { gte: start, lt: new Date(start.getTime() + 24 * 3_600_000) };
    }

    const appointments = await prisma.appointment.findMany({
      where: {
        facilityId,
        ...(doctorStaffId ? { doctorStaffId } : {}),
        ...(dateFilter ? { scheduledStart: dateFilter } : {}),
        ...(status ? { status } : {}),
      },
      include: { patient: true, doctor: { include: { user: true } }, department: true },
      orderBy: { scheduledStart: "asc" },
      take: 200,
    });
    return { appointments };
  });
}

const BookSchema = z.object({
  doctorStaffId: z.string(),
  patientId: z.string(),
  departmentId: z.string().optional(),
  type: z.enum(["NEW", "FOLLOW_UP", "PROCEDURE", "REVIEW", "TELEMEDICINE", "EMERGENCY_OVERRIDE"]).optional(),
  source: z.enum(["APPOINTMENT", "WALK_IN", "REFERRAL", "EMERGENCY", "FOLLOW_UP", "AMBULANCE"]).optional(),
  priority: z.enum(["ROUTINE", "URGENT", "EMERGENCY"]).optional(),
  roomLabel: z.string().optional(),
  scheduledStart: z.string(),
  scheduledEnd: z.string(),
  reason: z.string().optional(),
  facilityId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("appointment:create", body?.facilityId);
    if (!staff) throw new BadRequestError("Appointments must be booked by a staff account.");
    const parsed = BookSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid appointment data.");

    try {
      const appointment = await bookAppointment({
        facilityId,
        departmentId: parsed.data.departmentId,
        doctorStaffId: parsed.data.doctorStaffId,
        patientId: parsed.data.patientId,
        type: parsed.data.type,
        source: parsed.data.source,
        priority: parsed.data.priority,
        roomLabel: parsed.data.roomLabel,
        scheduledStart: new Date(parsed.data.scheduledStart),
        scheduledEnd: new Date(parsed.data.scheduledEnd),
        reason: parsed.data.reason,
        createdByStaffId: staff.id,
        byUserId: session.userId,
      });
      return { appointment };
    } catch (err) {
      if (err instanceof SlotConflictError) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
