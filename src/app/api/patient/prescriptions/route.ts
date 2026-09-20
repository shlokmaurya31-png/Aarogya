import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requirePatientContext, resolveReadScope } from "@/lib/patient/context";
import { listPrescriptions } from "@/lib/patient/experience/medications";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const ctx = await requirePatientContext();
    const { searchParams } = new URL(req.url);
    const scope = await resolveReadScope(ctx, searchParams.get("patientId"));
    return { prescriptions: await listPrescriptions(scope) };
  });
}
