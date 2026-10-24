import { NextRequest } from "next/server";
import { requireSession, withApiErrors } from "@/lib/auth/rbac";
import { removeLoginPhone } from "@/lib/auth/loginPhones";

/** DELETE — removes a verified phone from your work login (it still counts for the own-record check). */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => removeLoginPhone((await requireSession()).userId, (await params).id));
}
