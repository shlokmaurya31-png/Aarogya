import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { rateLimit } from "@/lib/auth/rateLimit";
import { requirePatientActor, resolveActScope } from "@/lib/patient/context";
import { startUpload } from "@/lib/patient/experience/resumableUpload";

/** POST { name, contentType, sizeBytes, title?, type? } — start a resumable upload (Flagship 5, 6c); then PUT its pieces in order. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const ctx = await requirePatientActor();
    const rl = await rateLimit(`patient-upload:${ctx.userId}`, 20, 60 * 60_000);
    if (!rl.allowed) throw new BadRequestError("Too many uploads. Try again later.");
    const scope = await resolveActScope(ctx);
    if (!scope.isSelf) throw new BadRequestError("Only the patient can upload to their record.");
    return startUpload(ctx.userId, (await req.json().catch(() => ({}))) as Record<string, unknown>);
  });
}
