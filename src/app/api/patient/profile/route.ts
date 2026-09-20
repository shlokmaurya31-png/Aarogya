import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requirePatientContext, requirePatientActor, resolveReadScope, resolveActScope } from "@/lib/patient/context";
import { getProfile, updateProfile } from "@/lib/patient/experience/profile";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const ctx = await requirePatientContext();
    const { searchParams } = new URL(req.url);
    const scope = await resolveReadScope(ctx, searchParams.get("patientId"));
    return getProfile(scope);
  });
}

/** Narrow, mass-assignment-proof update of contact/communication preferences only. */
export async function PATCH(req: NextRequest) {
  return withApiErrors(async () => {
    const ctx = await requirePatientActor();
    const scope = await resolveActScope(ctx);
    const body = await req.json().catch(() => ({}));
    return updateProfile(scope, body);
  });
}
