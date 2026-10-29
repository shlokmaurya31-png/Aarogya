import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { dryRunImport } from "@/lib/hospital/legacyImport/service";

/**
 * POST { profile, patientsCsv, encountersCsv }: the DRY RUN of a legacy import
 * (Flagship 2, step 6): the report (counts, every refused row with its reason,
 * dropped identity columns) and its dryRunHash. Writes nothing. Hospital admin.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => ({}));
    const { facilityId } = await requireFacilityStaff("legacy-import:run", body?.facilityId);
    return dryRunImport(facilityId, body);
  });
}
