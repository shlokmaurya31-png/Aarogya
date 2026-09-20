import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requirePatientContext, requirePatientActor, resolveReadScope, resolveActScope, listAccessiblePatients } from "@/lib/patient/context";
import { listGrantedDelegations, inviteDelegate } from "@/lib/patient/experience/family";

/** Delegations the patient has granted, plus the patients THIS caller can access. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const ctx = await requirePatientContext();
    const { searchParams } = new URL(req.url);
    const scope = await resolveReadScope(ctx, searchParams.get("patientId"));
    const [granted, accessible] = await Promise.all([
      listGrantedDelegations(scope),
      listAccessiblePatients(ctx),
    ]);
    return { granted, accessible: accessible.map((a) => ({ patientId: a.patientId, relationship: a.relationship, isSelf: a.isSelf, scopes: a.scopes })) };
  });
}

const InviteSchema = z.object({
  relationship: z.string().min(1),
  scopes: z.array(z.string().min(1)).min(1),
  invitedContact: z.string().min(1),
  invitedName: z.string().optional(),
  expiresAt: z.string().optional(),
}).strict();

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const ctx = await requirePatientActor();
    const scope = await resolveActScope(ctx);
    const parsed = InviteSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError("Invitation details are incomplete.");
    // inviteToken is returned ONCE for out-of-band delivery; never stored in plaintext.
    return inviteDelegate(scope, ctx.userId, parsed.data);
  });
}
