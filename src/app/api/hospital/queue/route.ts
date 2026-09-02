import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { enterQueue } from "@/lib/hospital/queue";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const queueType = searchParams.get("queueType");
    const practitionerStaffId = searchParams.get("practitionerStaffId");
    const status = searchParams.get("status");

    const entries = await prisma.queueEntry.findMany({
      where: {
        facilityId,
        ...(queueType ? { queueType } : {}),
        ...(practitionerStaffId ? { practitionerStaffId } : {}),
        status: status ? status : { in: ["WAITING", "CALLED", "IN_SERVICE"] },
      },
      include: { patient: true, encounter: true, appointment: true, practitioner: { include: { user: true } } },
      orderBy: [{ priorityScore: "asc" }, { enteredAt: "asc" }],
      take: 200,
    });
    return { entries };
  });
}

const EnterSchema = z.object({
  patientId: z.string(),
  queueType: z.enum(["REGISTRATION", "TRIAGE", "OPD_DOCTOR", "ED"]),
  departmentId: z.string().optional(),
  encounterId: z.string().optional(),
  appointmentId: z.string().optional(),
  practitionerStaffId: z.string().optional(),
  requestedPriority: z.enum(["ROUTINE", "URGENT", "EMERGENCY"]).optional(),
  facilityId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("queue:manage", body?.facilityId);
    const parsed = EnterSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestError("Invalid queue-entry data.");

    const entry = await enterQueue({
      facilityId,
      departmentId: parsed.data.departmentId,
      queueType: parsed.data.queueType,
      patientId: parsed.data.patientId,
      encounterId: parsed.data.encounterId,
      appointmentId: parsed.data.appointmentId,
      practitionerStaffId: parsed.data.practitionerStaffId,
      requestedPriority: parsed.data.requestedPriority,
      createdByStaffId: staff?.id,
      byUserId: session.userId,
    });
    return { entry };
  });
}
