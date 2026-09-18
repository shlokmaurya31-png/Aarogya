import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { listOverrides } from "@/lib/config";

/** GET: list an organization's configuration overrides (scoped read). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("configuration:read");
    const sp = new URL(req.url).searchParams;
    const organizationId = sp.get("organizationId");
    if (!organizationId) throw new BadRequestError("organizationId is required.");
    return { overrides: await listOverrides(m, organizationId, { status: sp.get("status") ?? undefined }) };
  });
}
