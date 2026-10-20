import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { grantsAboutMe } from "@/lib/household/grants";

/** GET — who acts for you, and how (Week 5b). */
export async function GET() {
  return withApiErrors(async () => ({ grants: await grantsAboutMe((await patientSession()).userId) }));
}
