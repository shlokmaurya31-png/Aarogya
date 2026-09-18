import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { publishOverride } from "@/lib/config";
import type { Scope } from "@/lib/config";

/** POST: publish the DRAFT for a key at a scope (race-safe, versioned, effective-dated). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("configuration:publish");
    const b = await req.json().catch(() => ({}));
    if (!b?.key || !b?.scope || !b?.organizationId) throw new BadRequestError("key, scope and organizationId are required.");
    return { override: await publishOverride(m, { key: b.key, scope: b.scope as Scope, organizationId: b.organizationId, facilityId: b.facilityId ?? null, departmentId: b.departmentId ?? null, effectiveFrom: b.effectiveFrom ? new Date(b.effectiveFrom) : undefined, reason: b.reason }) };
  });
}
