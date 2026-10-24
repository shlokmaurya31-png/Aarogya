import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { completeClaim } from "@/lib/household/comingOfAge";

/** POST { claimId, code, email, password } — take over your own profile with the code sent to you or handed over in person (Week 5b). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const b = await req.json().catch(() => ({}));
    const out = await completeClaim(String(b?.claimId ?? ""), b?.code, { email: b?.email, password: b?.password });
    return { status: "CLAIMED", lapsedGrants: out.lapsedGrants };
  });
}
