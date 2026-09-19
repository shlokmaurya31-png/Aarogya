import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { listTemplates } from "@/lib/workflow-builder";

/** GET: the starter template catalogue (copied into drafts, never auto-published). */
export async function GET() {
  return withApiErrors(async () => {
    await requireActorMemberships("workflow:read");
    return { templates: listTemplates() };
  });
}
