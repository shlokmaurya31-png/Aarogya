import { NextRequest } from "next/server";
import { BadRequestError, withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { uploadForMember } from "@/lib/household/proxy";

/** POST multipart (file, title, type) — upload to a member's profile, as their proxy (UPLOAD) (Week 5b). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ personId: string }> }) {
  return withApiErrors(async () => {
    const s = await patientSession();
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file !== "object" || !("arrayBuffer" in file)) throw new BadRequestError("Attach a file.");
    const f = file as File;
    const doc = await uploadForMember(s.userId, (await params).personId, { bytes: Buffer.from(await f.arrayBuffer()), contentType: f.type, originalName: f.name, title: String(form?.get("title") ?? ""), type: String(form?.get("type") ?? "REPORT") });
    return { id: doc.id, title: doc.title, uploadedAt: doc.uploadedAt };
  });
}
