import { NextRequest } from "next/server";
import { requireSession, withApiErrors } from "@/lib/auth/rbac";
import { listLoginPhones, startLoginPhone } from "@/lib/auth/loginPhones";

/** GET — your work login's verified phones (masked) (5b follow-up). */
export async function GET() {
  return withApiErrors(async () => ({ phones: await listLoginPhones((await requireSession()).userId) }));
}

/** POST { phone } — sends a code to the phone. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const s = await requireSession();
    const body = (await req.json().catch(() => ({}))) as { phone?: unknown };
    return startLoginPhone(s.userId, body.phone);
  });
}
