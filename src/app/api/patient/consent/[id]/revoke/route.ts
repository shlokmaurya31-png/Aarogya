import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requirePatientActor, resolveActScope } from "@/lib/patient/context";
import { revokePatientConsent } from "@/lib/patient/experience/consent";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const ctx = await requirePatientActor();
    const scope = await resolveActScope(ctx);
    const body = await req.json().catch(() => ({}));
    await revokePatientConsent(scope, ctx.userId, id, typeof body?.reason === "string" ? body.reason : undefined);
    return { ok: true };
  });
}
