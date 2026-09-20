import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requirePatientContext, requirePatientActor, resolveReadScope, resolveActScope } from "@/lib/patient/context";
import { listPatientConsents, createSharingRequest } from "@/lib/patient/experience/consent";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const ctx = await requirePatientContext();
    const { searchParams } = new URL(req.url);
    const scope = await resolveReadScope(ctx, searchParams.get("patientId"));
    return { consents: await listPatientConsents(scope) };
  });
}

const ShareSchema = z.object({
  purpose: z.string().min(1),
  scopes: z.array(z.string().min(1)).min(1),
  recipientType: z.string().min(1),
  recipientIdentifier: z.string().min(1),
  recipientName: z.string().optional(),
  expiresAt: z.string().optional(),
}).strict();

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const ctx = await requirePatientActor();
    const scope = await resolveActScope(ctx);
    const parsed = ShareSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError("Sharing details are incomplete.");
    const consent = await createSharingRequest(scope, ctx.userId, parsed.data);
    return { ok: true, consentId: consent.id };
  });
}
