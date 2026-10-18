import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { withdrawPatientRecord } from "@/lib/documents/merge";

/** Week 4a: withdraw one of your entries. Hospitals treating you no longer see it (unconfirmed shared allergies are taken back). */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    return withdrawPatientRecord(session.userId, id);
  });
}
