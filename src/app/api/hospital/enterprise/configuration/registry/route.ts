import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { listRegistry } from "@/lib/config";

/** GET: the closed configuration key registry (exact keys + templated families). */
export async function GET() {
  return withApiErrors(async () => {
    await requireActorMemberships("configuration:read");
    return listRegistry();
  });
}
