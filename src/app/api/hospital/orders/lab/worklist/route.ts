import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";

/**
 * Laboratory worklist (brief §16) — operational buckets by specimen/result
 * status, not a single flat list. TAT is derived from the timestamp columns
 * already on Specimen/LabResult at read time (brief §37/§38's "derive from
 * timestamps, don't pre-aggregate" — same philosophy as commandCenter.ts).
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const specimenInclude = {
      labOrder: { include: { patient: true, encounter: true } },
    } as const;

    const [pendingCollection, pendingReceipt, pendingAcceptance, rejectedAwaitingRecollection, pendingResult, pendingVerification, criticalResults] = await Promise.all([
      prisma.specimen.findMany({ where: { facilityId, status: "COLLECTION_PENDING" }, include: specimenInclude, orderBy: { createdAt: "asc" } }),
      prisma.specimen.findMany({ where: { facilityId, status: "COLLECTED" }, include: specimenInclude, orderBy: { collectedAt: "asc" } }),
      prisma.specimen.findMany({ where: { facilityId, status: "RECEIVED" }, include: specimenInclude, orderBy: { receivedAt: "asc" } }),
      prisma.specimen.findMany({ where: { facilityId, status: "REJECTED", recollections: { none: {} } }, include: specimenInclude, orderBy: { rejectedAt: "asc" } }),
      prisma.specimen.findMany({ where: { facilityId, status: "ACCEPTED" }, include: specimenInclude, orderBy: { acceptedAt: "asc" } }),
      prisma.labResult.findMany({
        where: { status: "ENTERED", isCurrent: true, labOrder: { encounter: { facilityId } } },
        include: { labOrder: { include: { patient: true, encounter: true } } },
        orderBy: { resultedAt: "asc" },
      }),
      prisma.labResult.findMany({
        where: { isCritical: true, acknowledgedAt: null, isCurrent: true, labOrder: { encounter: { facilityId } } },
        include: { labOrder: { include: { patient: true, encounter: true } } },
        orderBy: { resultedAt: "asc" },
      }),
    ]);

    const now = Date.now();
    const ageMinutes = (t: Date | null) => (t ? Math.round((now - t.getTime()) / 60000) : null);

    return {
      pendingCollection: pendingCollection.map((s) => ({ ...s, ageMinutes: ageMinutes(s.createdAt) })),
      pendingReceipt: pendingReceipt.map((s) => ({ ...s, ageMinutes: ageMinutes(s.collectedAt) })),
      pendingAcceptance: pendingAcceptance.map((s) => ({ ...s, ageMinutes: ageMinutes(s.receivedAt) })),
      rejectedAwaitingRecollection,
      pendingResult: pendingResult.map((s) => ({ ...s, ageMinutes: ageMinutes(s.acceptedAt) })),
      pendingVerification: pendingVerification.map((r) => ({ ...r, ageMinutes: ageMinutes(r.resultedAt) })),
      criticalResults: criticalResults.map((r) => ({ ...r, ageMinutes: ageMinutes(r.resultedAt) })),
    };
  });
}
