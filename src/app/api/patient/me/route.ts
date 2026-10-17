import { withApiErrors } from "@/lib/auth/rbac";
import { requirePatientSelf } from "@/lib/auth/patientRbac";
import { buildPatientSummary } from "@/lib/patient/summary";
import { buildPatientTimeline } from "@/lib/patient/timeline";

/** A patient's own longitudinal record — read-only, self-scoped only (see src/lib/auth/patientRbac.ts). */
export async function GET() {
  return withApiErrors(async () => {
    const { patient } = await requirePatientSelf();
    const [summary, timeline] = await Promise.all([
      buildPatientSummary(patient.id, { kind: "PATIENT" }),
      buildPatientTimeline(patient.id, { kind: "PATIENT" }),
    ]);
    return { summary, timeline };
  });
}
