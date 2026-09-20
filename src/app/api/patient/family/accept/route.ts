import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requirePatientActor } from "@/lib/patient/context";
import { acceptDelegation } from "@/lib/patient/experience/family";

/** Accept a family/caregiver invitation as the authenticated caller. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const ctx = await requirePatientActor();
    const body = await req.json().catch(() => ({}));
    if (typeof body?.token !== "string") throw new BadRequestError("An invitation token is required.");
    return acceptDelegation(ctx, body.token);
  });
}
