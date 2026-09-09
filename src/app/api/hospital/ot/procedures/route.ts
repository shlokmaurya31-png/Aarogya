import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createProcedure } from "@/lib/hospital/surgery";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("hospital:command-center:view", searchParams.get("facilityId") ?? undefined);
    const procedures = await prisma.procedure.findMany({ where: { facilityId, active: true }, orderBy: { name: "asc" } });
    return { procedures };
  });
}
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("ot:theatre:manage", body?.facilityId);
    if (!body?.code || !body?.name) throw new BadRequestError("code and name are required.");
    const procedure = await createProcedure({ facilityId, code: body.code, name: body.name, description: body.description, specialty: body.specialty, typicalDurationMinutes: body.typicalDurationMinutes, byUserId: session.userId });
    return { procedure };
  });
}
