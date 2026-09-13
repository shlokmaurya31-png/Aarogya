import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { setOrganizationMembershipScope, removeOrganizationMembership } from "@/lib/enterprise/memberships";

const patchSchema = z.object({
  isAdmin: z.boolean().optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ membershipId: string }> }) {
  return withApiErrors(async () => {
    const { membershipId } = await params;
    const m = await requireActorMemberships("enterprise:membership:manage");
    const parsed = patchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    return { membership: await setOrganizationMembershipScope(m, membershipId, parsed.data) };
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ membershipId: string }> }) {
  return withApiErrors(async () => {
    const { membershipId } = await params;
    const m = await requireActorMemberships("enterprise:membership:manage");
    await removeOrganizationMembership(m, membershipId);
    return { ok: true };
  });
}
