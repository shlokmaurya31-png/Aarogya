import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { setOverride } from "@/lib/config";
import type { Scope } from "@/lib/config";

/**
 * POST: create/update the DRAFT value for a key at a scope. The key must be in the
 * registry (no arbitrary keys); the value is validated; the change is not live until
 * published. Scope is verified against the caller's D1 membership.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("configuration:manage");
    const b = await req.json().catch(() => ({}));
    if (!b?.key || !b?.scope || !b?.organizationId || b?.value === undefined) throw new BadRequestError("key, scope, organizationId and value are required.");
    return { override: await setOverride(m, { key: b.key, scope: b.scope as Scope, organizationId: b.organizationId, facilityId: b.facilityId ?? null, departmentId: b.departmentId ?? null, value: String(b.value), reason: b.reason }) };
  });
}
