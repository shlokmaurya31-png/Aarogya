import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { parseBuilderDocument, compileBuilderDocument, diffConfigs } from "@/lib/workflow-builder";

/** POST: semantic diff between an optional `before` document and an `after` document. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    await requireActorMemberships("workflow:read");
    const body = await req.json().catch(() => ({}));
    const after = compileBuilderDocument(parseBuilderDocument(body?.after));
    const before = body?.before ? compileBuilderDocument(parseBuilderDocument(body.before)) : null;
    return diffConfigs(before, after);
  });
}
