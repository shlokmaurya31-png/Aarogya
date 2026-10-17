import { NextRequest } from "next/server";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { requirePatientSelf } from "@/lib/auth/patientRbac";
import { endOwnAccessSession } from "@/lib/patient/accessSession";

/** POST — the patient revokes/ends their own access session. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { session: authSession, patient } = await requirePatientSelf();
    const { id } = await params;

    const result = await endOwnAccessSession(id, patient.id, authSession.userId);
    if (!result) throw new NotFoundError("Session not found.");
    return { ok: true, status: result.status };
  });
}
