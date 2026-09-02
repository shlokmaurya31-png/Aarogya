import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { getAvailableSlots } from "@/lib/hospital/doctorSchedule";

/** Computed bookable slots for one doctor on one date (brief §7/§6) — never a persisted slot table. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ staffId: string }> }) {
  return withApiErrors(async () => {
    const { staffId } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const date = searchParams.get("date");
    if (!date) throw new BadRequestError("date (yyyy-mm-dd) is required.");

    const staff = await prisma.hospitalStaffProfile.findUnique({ where: { id: staffId } });
    if (!staff || staff.facilityId !== facilityId) throw new NotFoundError("Doctor not found.");

    const slots = await getAvailableSlots(staffId, new Date(`${date}T00:00:00`));
    return { slots };
  });
}
