import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { rateLimit } from "@/lib/auth/rateLimit";
import { StorageValidationError } from "@/lib/storage";
import { requirePatientActor, resolveActScope } from "@/lib/patient/context";
import { uploadPatientDocument, PATIENT_DOCUMENT_TYPES, type PatientDocumentType } from "@/lib/patient/experience/documents";

/**
 * Multipart: file, title, type? (REPORT | REFERRAL_LETTER | ID_PROOF | OTHER).
 * The patient's own record only (a delegate can't upload). Audited.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const ctx = await requirePatientActor();
    const rl = await rateLimit(`patient-upload:${ctx.userId}`, 20, 60 * 60_000);
    if (!rl.allowed) throw new BadRequestError("Too many uploads. Try again later.");
    const scope = await resolveActScope(ctx);

    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File) || file.size === 0) throw new BadRequestError("Attach a file.");
    const title = String(form?.get("title") ?? "").trim() || file.name;
    const rawType = String(form?.get("type") ?? "OTHER");
    if (!(PATIENT_DOCUMENT_TYPES as readonly string[]).includes(rawType)) throw new BadRequestError(`type must be one of ${PATIENT_DOCUMENT_TYPES.join(", ")}.`);

    try {
      const document = await uploadPatientDocument(scope, ctx.userId, {
        bytes: Buffer.from(await file.arrayBuffer()), contentType: file.type, originalName: file.name, title, type: rawType as PatientDocumentType,
      });
      return { document };
    } catch (err) {
      if (err instanceof StorageValidationError) throw new BadRequestError(`Document rejected: ${err.message}`);
      throw err;
    }
  });
}
