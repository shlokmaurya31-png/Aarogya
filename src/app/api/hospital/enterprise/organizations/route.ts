import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { createOrganization, listOrganizationsForActor } from "@/lib/enterprise/organizations";

/**
 * Phase D1 — organizations the caller can see, and (platform-only) create.
 * The list is scoped to the caller's memberships; a non-platform caller never
 * learns another organization exists.
 */
export async function GET() {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("enterprise:organization:read");
    return { organizations: await listOrganizationsForActor(m) };
  });
}

const createSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with dashes.").optional(),
  legalName: z.string().optional().nullable(),
});

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("enterprise:platform:manage");
    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    return { organization: await createOrganization(m, parsed.data) };
  });
}
