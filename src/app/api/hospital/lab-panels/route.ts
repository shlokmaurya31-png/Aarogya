import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";

/** Lab test panels (brief §10) — panel membership is data-driven, no duplicated test definitions. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const panels = await prisma.labPanel.findMany({
      where: { active: true, OR: [{ facilityId }, { facilityId: null }] },
      include: { tests: { include: { catalogTest: true } } },
      orderBy: { name: "asc" },
    });
    return { panels };
  });
}
