import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { getHistory } from "@/lib/config";
import type { Scope } from "@/lib/config";

/** GET: immutable change history for a (scope, key), tenant-scoped. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("configuration:read");
    const sp = new URL(req.url).searchParams;
    const key = sp.get("key");
    const scope = sp.get("scope") as Scope | null;
    const organizationId = sp.get("organizationId");
    if (!key || !scope || !organizationId) throw new BadRequestError("key, scope and organizationId are required.");
    return { history: await getHistory(m, { key, scope, organizationId, facilityId: sp.get("facilityId") ?? undefined, departmentId: sp.get("departmentId") ?? undefined }) };
  });
}
