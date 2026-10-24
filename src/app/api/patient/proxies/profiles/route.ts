import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { proxyProfiles } from "@/lib/household/grants";

/** GET — the profile switcher: members you may act for, with your permissions (Week 5b). */
export async function GET() {
  return withApiErrors(async () => ({ profiles: await proxyProfiles((await patientSession()).userId) }));
}
