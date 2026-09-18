import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { resetOverride } from "@/lib/config";
import type { Scope } from "@/lib/config";

/** POST: reset (retire) the override for a key at a scope so it inherits again. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("configuration:reset");
    const b = await req.json().catch(() => ({}));
    if (!b?.key || !b?.scope || !b?.organizationId) throw new BadRequestError("key, scope and organizationId are required.");
    return resetOverride(m, { key: b.key, scope: b.scope as Scope, organizationId: b.organizationId, facilityId: b.facilityId ?? null, departmentId: b.departmentId ?? null, reason: b.reason });
  });
}
