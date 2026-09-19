import { NextRequest } from "next/server";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { getTemplate } from "@/lib/workflow-builder";

/** GET: a template's builder document, to copy into a new draft. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    await requireActorMemberships("workflow:read");
    const { id } = await params;
    const t = getTemplate(id);
    if (!t) throw new NotFoundError();
    return { id: t.id, name: t.name, description: t.description, document: t.document };
  });
}
