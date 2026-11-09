import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { shareFromApp } from "@/lib/hospital/scanShare/service";

/** POST { hip, counter, sig, abhaAddress }: share your ABHA profile with the facility you scanned; you get a token (Flagship 6, mock gateway). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    return shareFromApp(session.userId, await req.json().catch(() => ({})));
  });
}
