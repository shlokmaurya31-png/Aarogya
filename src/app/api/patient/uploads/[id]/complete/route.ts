import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { StorageValidationError } from "@/lib/storage";
import { requirePatientActor, resolveActScope } from "@/lib/patient/context";
import { completeUpload } from "@/lib/patient/experience/resumableUpload";

/** POST — every piece is here: the document is created, exactly as a one-shot upload. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const ctx = await requirePatientActor();
    try {
      return await completeUpload(await resolveActScope(ctx), ctx.userId, (await params).id);
    } catch (err) {
      if (err instanceof StorageValidationError) throw new BadRequestError(`Document rejected: ${err.message}`);
      throw err;
    }
  });
}
