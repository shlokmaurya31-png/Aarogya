import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requirePatientActor, resolveActScope } from "@/lib/patient/context";
import { revokeDelegation } from "@/lib/patient/experience/family";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const ctx = await requirePatientActor();
    const scope = await resolveActScope(ctx);
    const body = await req.json().catch(() => ({}));
    await revokeDelegation(scope, ctx.userId, id, typeof body?.reason === "string" ? body.reason : undefined);
    return { ok: true };
  });
}
