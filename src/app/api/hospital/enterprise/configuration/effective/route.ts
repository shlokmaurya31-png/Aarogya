import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { resolveConfig } from "@/lib/config";

/**
 * GET: the effective value for a key at a scope + time, WITH full provenance (the
 * whole resolution chain + winning source + version) — the enterprise explainer.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("configuration:read");
    const sp = new URL(req.url).searchParams;
    const key = sp.get("key");
    const organizationId = sp.get("organizationId");
    if (!key || !organizationId) throw new BadRequestError("key and organizationId are required.");
    const atTime = sp.get("atTime");
    return resolveConfig(m, {
      key, organizationId,
      facilityId: sp.get("facilityId") ?? undefined,
      departmentId: sp.get("departmentId") ?? undefined,
      atTime: atTime ? new Date(atTime) : undefined,
    });
  });
}
