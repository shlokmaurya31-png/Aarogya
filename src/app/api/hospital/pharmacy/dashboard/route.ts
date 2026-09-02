import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";

/** Pharmacy Dashboard (brief §22) — every count a live query, facility-scoped. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("medication:verify", searchParams.get("facilityId") ?? undefined);

    const [pendingVerification, urgentPending, rejected, clarificationRequests, dispensingQueue, controlledQueue] = await Promise.all([
      prisma.medicationOrder.count({ where: { encounter: { facilityId }, status: "PHARMACY_REVIEW" } }),
      prisma.medicationOrder.count({ where: { encounter: { facilityId }, status: "PHARMACY_REVIEW", order: { priority: { in: ["URGENT", "EMERGENCY"] } } } }),
      prisma.medicationOrder.count({ where: { encounter: { facilityId }, status: "REJECTED" } }),
      prisma.medicationOrder.count({
        where: { encounter: { facilityId }, status: "HELD", verifications: { some: { decision: "CLARIFICATION_REQUESTED" } } },
      }),
      prisma.medicationOrder.count({ where: { encounter: { facilityId }, status: "VERIFIED" } }),
      prisma.medicationOrder.count({ where: { encounter: { facilityId }, status: { in: ["PHARMACY_REVIEW", "VERIFIED"] }, isControlled: true } }),
    ]);

    // "Delayed medications" (brief §22) — verified but not yet dispensed for over 30 min.
    const delayed = await prisma.medicationOrder.count({
      where: { encounter: { facilityId }, status: "VERIFIED", orderedAt: { lte: new Date(Date.now() - 30 * 60_000) } },
    });

    return { pendingVerification, urgentPending, rejected, clarificationRequests, dispensingQueue, controlledQueue, delayed };
  });
}
