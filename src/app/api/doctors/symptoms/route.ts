import { withApiErrors } from "@/lib/auth/rbac";
import { symptomList } from "@/lib/doctors/directory";

/** GET — the symptom list for search (Week 5a; pending the clinical advisor's sign-off, and it says so). */
export async function GET() {
  return withApiErrors(async () => symptomList());
}
