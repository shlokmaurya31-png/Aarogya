import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { parseBuilderDocument, buildValidationReport } from "@/lib/workflow-builder";

/** POST: structured validation report for a builder document (advisory + server-side). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    await requireActorMemberships("workflow:read");
    const body = await req.json().catch(() => ({}));
    const doc = parseBuilderDocument(body?.document);
    return buildValidationReport(doc);
  });
}
