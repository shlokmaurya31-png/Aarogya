import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { builderMetadata } from "@/lib/workflow-builder";

/** GET: builder metadata (triggers from D6, actions/operators/limits from D7). */
export async function GET() {
  return withApiErrors(async () => {
    await requireActorMemberships("workflow:read");
    return builderMetadata();
  });
}
