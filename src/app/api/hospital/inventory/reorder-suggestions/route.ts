import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { getReorderSuggestions } from "@/lib/hospital/inventory/inventoryAdvanced";

/** Reorder SUGGESTIONS only — never an automatic PO (brief §62). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:report:view", searchParams.get("facilityId") ?? undefined);
    return { suggestions: await getReorderSuggestions(facilityId) };
  });
}
