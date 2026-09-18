import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { getProviderHealth } from "@/lib/commercial/analytics/providerHealth";

/** Platform-only provider health. Never makes a live provider call; RAZORPAY shows NOT_CONFIGURED without credentials. */
export async function GET() {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    return getProviderHealth(m);
  });
}
