import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createAmbulance } from "@/lib/hospital/operations/service";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("operations:command:view", searchParams.get("facilityId") ?? undefined);
    const ambulances = await prisma.ambulance.findMany({ where: { facilityId }, orderBy: { registration: "asc" }, take: 200 });
    return { ambulances };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("ambulance:manage", body?.facilityId);
    if (!body?.registration || !body?.type) throw new BadRequestError("registration and type are required.");
    const ambulance = await createAmbulance({ facilityId, registration: body.registration, type: body.type, capabilities: body.capabilities, byUserId: session.userId });
    return { ambulance };
  });
}
