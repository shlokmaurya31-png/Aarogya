import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { getImportBatch } from "@/lib/hospital/legacyImport/service";

/** GET: one import batch of this facility (another facility's is a 404). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ batchId: string }> }) {
  return withApiErrors(async () => {
    const { facilityId } = await requireFacilityStaff("legacy-import:run", req.nextUrl.searchParams.get("facilityId") ?? undefined);
    const b = await getImportBatch(facilityId, (await params).batchId);
    return { batch: { id: b.id, sourceSystem: b.sourceSystem, status: b.status, counts: b.counts, startedAt: b.startedAt, committedAt: b.committedAt } };
  });
}
