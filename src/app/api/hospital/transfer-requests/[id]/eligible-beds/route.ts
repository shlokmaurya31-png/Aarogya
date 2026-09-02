import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { findEligibleBeds } from "@/lib/hospital/bed";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("transfer:approve", searchParams.get("facilityId") ?? undefined);

    const request = await prisma.transferRequest.findUnique({ where: { id } });
    if (!request || request.facilityId !== facilityId) throw new NotFoundError("Transfer request not found.");

    const beds = await findEligibleBeds(facilityId, {
      wardType: request.destinationWardType ?? undefined,
      isolationRequired: request.isolationRequired,
      genderRestriction: request.genderRestriction,
    });
    return { beds };
  });
}
