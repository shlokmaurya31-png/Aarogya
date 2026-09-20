import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requirePatientContext, resolveReadScope } from "@/lib/patient/context";
import { listBookableDoctors } from "@/lib/patient/experience/appointments";

/** Doctors the patient may request an appointment with, in their own facility. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const ctx = await requirePatientContext();
    const { searchParams } = new URL(req.url);
    const scope = await resolveReadScope(ctx, searchParams.get("patientId"));
    return { doctors: await listBookableDoctors(scope) };
  });
}
