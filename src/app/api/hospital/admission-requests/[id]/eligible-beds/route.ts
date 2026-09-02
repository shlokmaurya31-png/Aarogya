import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { findEligibleBeds } from "@/lib/hospital/bed";

/** Bed matching (brief §30) — a ranked list, never an auto-pick of "the first available bed." */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("admission:allocate", searchParams.get("facilityId") ?? undefined);

    const request = await prisma.admissionRequest.findUnique({ where: { id } });
    if (!request || request.facilityId !== facilityId) throw new NotFoundError("Admission request not found.");

    const beds = await findEligibleBeds(facilityId, {
      wardType: request.requestedWardType ?? undefined,
      isolationRequired: request.isolationRequired,
      genderRestriction: request.genderRestriction,
    });
    return { beds };
  });
}
