import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { listDefinitions, createDefinition } from "@/lib/workflows";

/** GET: list workflow definitions (scoped). POST: create a definition (platform-only). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:read");
    const sp = new URL(req.url).searchParams;
    return { definitions: await listDefinitions(m, { organizationId: sp.get("organizationId") ?? undefined, triggerEventType: sp.get("triggerEventType") ?? undefined }) };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:manage");
    const body = await req.json().catch(() => ({}));
    return { definition: await createDefinition(m, { organizationId: body?.organizationId ?? null, facilityId: body?.facilityId ?? null, key: body?.key, name: body?.name, description: body?.description, config: body?.config }) };
  });
}
