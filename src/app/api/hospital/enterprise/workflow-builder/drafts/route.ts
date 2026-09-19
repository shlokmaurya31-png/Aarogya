import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { listDrafts, saveDraft } from "@/lib/workflow-builder";

/** GET: list an org's builder drafts (scoped). POST: create/update a draft. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:read");
    const organizationId = new URL(req.url).searchParams.get("organizationId");
    if (!organizationId) throw new BadRequestError("organizationId is required.");
    return { drafts: await listDrafts(m, organizationId) };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:manage");
    const b = await req.json().catch(() => ({}));
    if (!b?.organizationId || !b?.key || !b?.name || b?.document === undefined) throw new BadRequestError("organizationId, key, name and document are required.");
    return { draft: await saveDraft(m, { id: b.id, organizationId: b.organizationId, facilityId: b.facilityId ?? null, workflowDefinitionId: b.workflowDefinitionId ?? null, key: b.key, name: b.name, document: b.document }) };
  });
}
