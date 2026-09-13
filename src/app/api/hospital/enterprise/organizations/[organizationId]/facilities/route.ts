import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { createFacility, listFacilitiesForActor } from "@/lib/enterprise/facilities";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ organizationId: string }> }) {
  return withApiErrors(async () => {
    const { organizationId } = await params;
    const m = await requireActorMemberships("enterprise:organization:read");
    // Membership scoping happens inside the service; a non-member sees an empty
    // list rather than a leak, and org access is asserted for admin views.
    return { facilities: await listFacilitiesForActor(m, organizationId) };
  });
}

const createSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with dashes.").optional(),
  city: z.string().optional().nullable(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ organizationId: string }> }) {
  return withApiErrors(async () => {
    const { organizationId } = await params;
    const m = await requireActorMemberships("enterprise:organization:manage");
    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    return { facility: await createFacility(m, organizationId, parsed.data) };
  });
}
