import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { confirmFactField } from "@/lib/documents/review";

/** Week 4a: confirm one field of a handwritten fact. Body { version }. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; field: string }> }) {
  return withApiErrors(async () => {
    const { id, field } = await params;
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const b = await req.json().catch(() => null);
    return confirmFactField(session.userId, id, field, { version: b?.version });
  });
}
