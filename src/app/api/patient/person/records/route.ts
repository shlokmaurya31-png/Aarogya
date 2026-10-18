import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { listOwnRecords } from "@/lib/documents/merge";

/** Week 4a: your patient-provided entries (from documents you confirmed), always labelled PATIENT_PROVIDED. */
export async function GET() {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    return listOwnRecords(session.userId);
  });
}
