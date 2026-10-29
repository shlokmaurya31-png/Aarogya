import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { confirmImport } from "@/lib/hospital/legacyImport/service";

/**
 * POST { profile, patientsCsv, encountersCsv, dryRunHash }: the confirmed run
 * of exactly the file the dry run reported (by its hash). The same file again
 * is a no-op. Hospital admin.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    const { session, facilityId } = await requireFacilityStaff("legacy-import:run", body?.facilityId);
    return confirmImport({ userId: session.userId, facilityId }, body);
  });
}
