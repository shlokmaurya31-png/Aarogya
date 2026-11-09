import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { scanTarget } from "@/lib/hospital/scanShare/service";

/** GET ?hip=&counter=&sig=: which facility and counter a scanned QR is (only a QR Aarogya issued). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const q = req.nextUrl.searchParams;
    return scanTarget(q.get("hip") ?? "", q.get("counter") ?? "", q.get("sig") ?? "");
  });
}
