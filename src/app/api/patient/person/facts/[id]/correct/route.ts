import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { correctFact } from "@/lib/documents/review";

/** Week 4a: correct a fact. Body { version, value, typedValueConfirmed }: the first call without typedValueConfirmed shows the value back. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const b = await req.json().catch(() => null);
    return correctFact(session.userId, id, { version: b?.version, value: b?.value, typedValueConfirmed: b?.typedValueConfirmed });
  });
}
