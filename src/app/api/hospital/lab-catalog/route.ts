import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";

/** Lab test catalog (brief §8) — facility-scoped entries plus global (facilityId=null) entries. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const tests = await prisma.labTestCatalog.findMany({
      where: { active: true, OR: [{ facilityId }, { facilityId: null }] },
      include: { referenceRanges: true },
      orderBy: { name: "asc" },
    });
    return { tests };
  });
}
