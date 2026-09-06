import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { dailyCollectionByMethod, outstandingByPayer, chargeInvoiceCollectionLeakage, claimAging } from "@/lib/hospital/billing/reconciliation";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("billing:reconciliation:view", searchParams.get("facilityId") ?? undefined);

    const fromParam = searchParams.get("dateFrom");
    const toParam = searchParams.get("dateTo");
    if (!fromParam || !toParam) throw new BadRequestError("dateFrom and dateTo query params are required.");
    const from = new Date(fromParam);
    const to = new Date(toParam);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new BadRequestError("dateFrom/dateTo must be valid dates.");

    const [collectionByMethod, outstanding, leakage, aging] = await Promise.all([
      dailyCollectionByMethod(facilityId, { from, to }),
      outstandingByPayer(facilityId),
      chargeInvoiceCollectionLeakage(facilityId, { from, to }),
      claimAging(facilityId),
    ]);

    return { collectionByMethod, outstandingByPayer: outstanding, chargeInvoiceCollectionLeakage: leakage, claimAging: aging };
  });
}
