import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("quality:incident:read", searchParams.get("facilityId") ?? undefined);
    const incident = await prisma.qualityIncident.findUnique({
      where: { id },
      include: {
        transitions: { orderBy: { createdAt: "asc" } },
        rca: true,
        capaActions: { orderBy: { createdAt: "desc" } },
        evidence: { orderBy: { createdAt: "desc" } },
        findings: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!incident || incident.facilityId !== facilityId) throw new NotFoundError("Quality incident not found.");
    return { incident };
  });
}
