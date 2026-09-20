import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requirePatientActor, resolveActScope } from "@/lib/patient/context";
import { grantPatientConsent } from "@/lib/patient/experience/consent";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const ctx = await requirePatientActor();
    const scope = await resolveActScope(ctx);
    await grantPatientConsent(scope, ctx.userId, id);
    return { ok: true };
  });
}
