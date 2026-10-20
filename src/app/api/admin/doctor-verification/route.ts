import { requirePermission, withApiErrors } from "@/lib/auth/rbac";
import { verificationQueue } from "@/lib/doctors/verification";

/** GET — the platform team's verification queue, oldest due first (Week 5a; doctor:verify). */
export async function GET() {
  return withApiErrors(async () => {
    await requirePermission("doctor:verify");
    return { cases: await verificationQueue() };
  });
}
