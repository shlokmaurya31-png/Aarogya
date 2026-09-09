import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { buildEdBoard } from "@/lib/hospital/emergency";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const cards = await buildEdBoard(facilityId);
    const columns = ["RESUSCITATION", "HIGH_PRIORITY", "STANDARD", "OBSERVATION", "TRIAGE_PENDING"];
    const byColumn = Object.fromEntries(columns.map((c) => [c, cards.filter((card) => card.column === c)]));
    return { cards, byColumn };
  });
}
