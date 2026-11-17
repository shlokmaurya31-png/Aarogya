import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requirePatientActor } from "@/lib/patient/context";
import { putUploadChunk, uploadProgress } from "@/lib/patient/experience/resumableUpload";

/** GET — how much of the file has arrived (asked after a dropped connection). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => uploadProgress((await requirePatientActor()).userId, (await params).id));
}

/** PUT ?offset=N, body: the piece's bytes — the next piece, in order; a piece already received is accepted as is. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const ctx = await requirePatientActor();
    const offset = Number(req.nextUrl.searchParams.get("offset"));
    return putUploadChunk(ctx.userId, (await params).id, offset, Buffer.from(await req.arrayBuffer()));
  });
}
