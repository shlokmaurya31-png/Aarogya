import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { importWorkflow } from "@/lib/workflow-builder";

/** POST: import a workflow document as a DRAFT (never directly published; revalidated). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:manage");
    const b = await req.json().catch(() => ({}));
    if (!b?.organizationId || !b?.key || !b?.name || b?.document === undefined) throw new BadRequestError("organizationId, key, name and document are required.");
    return { draft: await importWorkflow(m, { organizationId: b.organizationId, facilityId: b.facilityId ?? null, name: b.name, key: b.key, document: b.document }) };
  });
}
