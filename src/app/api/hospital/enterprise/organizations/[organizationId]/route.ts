import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { getOrganizationForActor, updateOrganization } from "@/lib/enterprise/organizations";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ organizationId: string }> }) {
  return withApiErrors(async () => {
    const { organizationId } = await params;
    const m = await requireActorMemberships("enterprise:organization:read");
    const org = await getOrganizationForActor(m, organizationId);
    if (!org) throw new NotFoundError();
    return { organization: org };
  });
}

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  legalName: z.string().optional().nullable(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ organizationId: string }> }) {
  return withApiErrors(async () => {
    const { organizationId } = await params;
    const m = await requireActorMemberships("enterprise:organization:manage");
    const parsed = updateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    return { organization: await updateOrganization(m, organizationId, parsed.data) };
  });
}
