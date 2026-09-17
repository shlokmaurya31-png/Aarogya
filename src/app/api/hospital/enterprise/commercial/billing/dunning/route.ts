import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { processBillingDunning } from "@/lib/billing/dunning";

/**
 * Platform-only: run one dunning pass (advances each eligible subscription at
 * most one stage). This is the explicit service boundary a future scheduler,
 * an administrator, or a test calls — no automated scheduler exists in-repo.
 */
export async function POST() {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    return processBillingDunning(m);
  });
}
