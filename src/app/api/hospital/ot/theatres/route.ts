import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createOperatingTheatre } from "@/lib/hospital/surgery";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("hospital:command-center:view", searchParams.get("facilityId") ?? undefined);
    const theatres = await prisma.operatingTheatre.findMany({ where: { facilityId }, orderBy: { name: "asc" } });
    return { theatres };
  });
}
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("ot:theatre:manage", body?.facilityId);
    if (!body?.name) throw new BadRequestError("name is required.");
    const ot = await createOperatingTheatre({ facilityId, name: body.name, type: body.type, departmentId: body.departmentId, capabilities: body.capabilities, byUserId: session.userId });
    return { theatre: ot };
  });
}
