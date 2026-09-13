import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { transitionOrganization } from "@/lib/enterprise/organizations";

const schema = z.object({
  to: z.enum(["ACTIVE", "SUSPENDED", "DEACTIVATED"]),
  reason: z.string().optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ organizationId: string }> }) {
  return withApiErrors(async () => {
    const { organizationId } = await params;
    const m = await requireActorMemberships("enterprise:organization:manage");
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    return { organization: await transitionOrganization(m, organizationId, parsed.data.to, parsed.data.reason) };
  });
}
