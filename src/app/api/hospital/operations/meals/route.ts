import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("operations:command:view", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status"); const period = searchParams.get("mealPeriod");
    const meals = await prisma.meal.findMany({ where: { facilityId, ...(status ? { status } : {}), ...(period ? { mealPeriod: period } : {}) }, orderBy: { plannedFor: "asc" }, take: 200 });
    return { meals };
  });
}
