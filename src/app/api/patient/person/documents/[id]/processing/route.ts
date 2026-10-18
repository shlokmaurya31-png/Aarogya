import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { processingStatus } from "@/lib/documents/patientView";

/** Week 4a: the processing of one of your documents (status only). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    return processingStatus(session.userId, id);
  });
}
