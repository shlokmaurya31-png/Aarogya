import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { publishDraft } from "@/lib/workflow-builder";

/** POST: compile + publish a builder draft through the authoritative D7 lifecycle. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:manage");
    const { id } = await params;
    return { definition: await publishDraft(m, id) };
  });
}
