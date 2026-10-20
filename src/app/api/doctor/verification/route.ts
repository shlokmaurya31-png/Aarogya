import { NextRequest } from "next/server";
import { BadRequestError, ForbiddenError, requireSession, withApiErrors } from "@/lib/auth/rbac";
import { submitVerification } from "@/lib/doctors/verification";

/** POST multipart (files: the registration certificate and degree, PDF or image) — opens the verification case (Week 5a). */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const s = await requireSession();
    if (s.role !== "DOCTOR") throw new ForbiddenError("doctor:profile:manage");
    const form = await req.formData().catch(() => null);
    const files = (form?.getAll("files") ?? []).filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f);
    if (!files.length) throw new BadRequestError("Attach your documents.");
    return submitVerification(s.userId, await Promise.all(files.map(async (f) => ({ bytes: Buffer.from(await f.arrayBuffer()), contentType: f.type, originalName: f.name }))));
  });
}
