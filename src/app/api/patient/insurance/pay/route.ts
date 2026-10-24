import { NextRequest } from "next/server";
import { BadRequestError, withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { payShare } from "@/lib/insurance/hospitalPayments";

/** POST { invoiceId, memberPersonId? } — start paying your share to the hospital's own gateway (the amount is the server's; any amount sent is ignored). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const s = await patientSession();
    const body = (await req.json().catch(() => ({}))) as { invoiceId?: unknown; memberPersonId?: unknown };
    if (typeof body.invoiceId !== "string") throw new BadRequestError("invoiceId is required.");
    return payShare({ userId: s.userId, memberPersonId: typeof body.memberPersonId === "string" ? body.memberPersonId : undefined }, body.invoiceId);
  });
}
