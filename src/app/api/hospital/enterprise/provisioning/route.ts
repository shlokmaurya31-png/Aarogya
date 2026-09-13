import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { provisionOrganization } from "@/lib/enterprise/provisioning";

const slug = z.string().min(1).regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with dashes.");

const schema = z.object({
  organization: z.object({ name: z.string().min(1), slug, legalName: z.string().optional().nullable() }),
  facility: z.object({ name: z.string().min(1), slug, city: z.string().optional().nullable() }),
  adminUserId: z.string().min(1),
  departments: z.array(z.string().min(1)).optional(),
});

/** Phase D1 — provision a whole tenant atomically. Platform-only, idempotent by slug. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("enterprise:platform:manage");
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid input.");
    return await provisionOrganization(m, parsed.data);
  });
}
