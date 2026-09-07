import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { prisma } from "@/lib/db";
import { reconcileBalances } from "@/lib/hospital/inventory/stockBalance";

/** The ledger-is-authoritative proof surface: recomputes balances from StockLedgerEntry and diffs against the materialized StockBalance cache. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("inventory:report:view", searchParams.get("facilityId") ?? undefined);
    const result = await prisma.$transaction((tx) => reconcileBalances(tx, facilityId));
    return result;
  });
}
