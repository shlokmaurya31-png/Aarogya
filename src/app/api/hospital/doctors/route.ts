import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";

/** Doctor directory for appointment booking (brief §6/§7) — facility-scoped, active staff only. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const doctors = await prisma.hospitalStaffProfile.findMany({
      where: { facilityId, status: "ACTIVE", user: { role: "DOCTOR" } },
      include: { user: true, department: true },
      orderBy: { user: { displayName: "asc" } },
    });
    return {
      doctors: doctors.map((d) => ({
        staffId: d.id,
        displayName: d.user.displayName,
        displayRole: d.displayRole,
        departmentId: d.departmentId,
        departmentName: d.department?.name ?? null,
      })),
    };
  });
}
