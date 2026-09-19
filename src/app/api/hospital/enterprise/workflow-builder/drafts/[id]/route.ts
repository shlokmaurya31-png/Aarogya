import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { getDraft, deleteDraft } from "@/lib/workflow-builder";

/** GET: a builder draft (scoped). DELETE: remove a draft. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:read");
    const { id } = await params;
    return { draft: await getDraft(m, id) };
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:manage");
    const { id } = await params;
    return deleteDraft(m, id);
  });
}
