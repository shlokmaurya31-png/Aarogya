import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { allowedTypesForBucket, maxSizeForBucket } from "@/lib/storage";
import type { PatientAccessScope } from "@/lib/patient/context";
import { PATIENT_DOCUMENT_TYPES, uploadPatientDocument, type PatientDocumentType } from "./documents";

/**
 * Flagship 5, step 6c — uploads that survive a dropping connection
 * (docs/MOBILE_ACCESSIBILITY.md §4). The phone sends the file in pieces of
 * CHUNK_BYTES, in order; after a drop it asks how much arrived and carries on
 * from there. A piece sent twice (its answer lost on the way back) is taken
 * once. When every byte is here, `completeUpload` hands the whole file to the
 * same `uploadPatientDocument` as a one-shot upload (the same checks, the same
 * owner, the same events), then deletes the pieces. An unfinished upload is
 * deleted after UPLOAD_TTL_MS.
 */
export const CHUNK_BYTES = 256 * 1024;
export const UPLOAD_TTL_MS = 24 * 60 * 60_000;
const BUCKET = "patient-uploads" as const;

type Session = { id: string; userId: string; status: string; sizeBytes: number; receivedBytes: number; expiresAt: Date };

async function ownOpen(userId: string, uploadId: string, now = new Date()): Promise<Session> {
  const s = await prisma.uploadSession.findUnique({ where: { id: uploadId } });
  if (!s || s.userId !== userId || (s.status === "OPEN" && s.expiresAt <= now)) throw new NotFoundError();
  return s;
}

const view = (s: Session) => ({ uploadId: s.id, sizeBytes: s.sizeBytes, receivedBytes: s.receivedBytes, chunkBytes: CHUNK_BYTES, complete: s.status === "COMPLETED" });

/** Start an upload: what the file is and how big. Nothing is stored yet. */
export async function startUpload(userId: string, body: { name?: unknown; contentType?: unknown; sizeBytes?: unknown; title?: unknown; type?: unknown }) {
  const contentType = typeof body.contentType === "string" ? body.contentType : "";
  if (!allowedTypesForBucket(BUCKET).includes(contentType)) throw new BadRequestError("PDFs and photos (JPEG, PNG or WebP) only.");
  const size = typeof body.sizeBytes === "number" && Number.isInteger(body.sizeBytes) ? body.sizeBytes : 0;
  if (size <= 0) throw new BadRequestError("The file is empty.");
  if (size > maxSizeForBucket(BUCKET)) throw new BadRequestError(`The file is too big (the most is ${Math.round(maxSizeForBucket(BUCKET) / 1024 / 1024)} MB).`);
  const type = typeof body.type === "string" && (PATIENT_DOCUMENT_TYPES as readonly string[]).includes(body.type) ? body.type : "REPORT";
  const originalName = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 200) : "upload";
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : originalName;
  const s = await prisma.uploadSession.create({ data: { userId, title, documentType: type, contentType, originalName, sizeBytes: size, expiresAt: new Date(Date.now() + UPLOAD_TTL_MS) } });
  return view(s);
}

/** How much of the file has arrived (the phone asks after a drop). */
export async function uploadProgress(userId: string, uploadId: string) {
  return view(await ownOpen(userId, uploadId));
}

/**
 * One piece, at its offset. The next piece in order is stored; a piece that
 * already arrived (a retry whose answer was lost) is accepted as is; anything
 * else is refused with how much has arrived, so the phone can carry on from there.
 */
export async function putUploadChunk(userId: string, uploadId: string, offset: number, bytes: Buffer) {
  const s = await ownOpen(userId, uploadId);
  if (s.status !== "OPEN") return view(s);
  if (!Number.isInteger(offset) || offset < 0) throw new BadRequestError("A piece needs its offset.");
  if (bytes.length === 0 || bytes.length > CHUNK_BYTES || offset + bytes.length > s.sizeBytes) throw new BadRequestError(`A piece is 1 byte to ${CHUNK_BYTES / 1024} KB, inside the file.`);
  if (offset < s.receivedBytes) return view(s);
  if (offset > s.receivedBytes) throw new ConflictError(`Expected the piece at ${s.receivedBytes}.`);
  const out = await prisma.$transaction(async (tx) => {
    const u = await tx.uploadSession.updateMany({ where: { id: s.id, status: "OPEN", receivedBytes: offset }, data: { receivedBytes: offset + bytes.length } });
    if (u.count !== 1) return tx.uploadSession.findUniqueOrThrow({ where: { id: s.id } });
    await tx.uploadChunk.create({ data: { sessionId: s.id, offset, bytes: new Uint8Array(bytes) } });
    return tx.uploadSession.findUniqueOrThrow({ where: { id: s.id } });
  });
  return view(out);
}

/** Every byte is here: the document is created exactly as a one-shot upload would be, and the pieces are deleted. Twice is once. */
export async function completeUpload(scope: PatientAccessScope, userId: string, uploadId: string) {
  const s = await prisma.uploadSession.findUnique({ where: { id: uploadId } });
  if (!s || s.userId !== userId) throw new NotFoundError();
  if (s.status === "COMPLETED") return { ...view(s), document: null };
  if (s.expiresAt <= new Date()) throw new NotFoundError();
  if (s.receivedBytes !== s.sizeBytes) throw new ConflictError(`${s.receivedBytes} of ${s.sizeBytes} bytes have arrived.`);
  const chunks = await prisma.uploadChunk.findMany({ where: { sessionId: s.id }, orderBy: { offset: "asc" }, select: { offset: true, bytes: true } });
  let at = 0;
  for (const c of chunks) { if (c.offset !== at) throw new ConflictError("A piece is missing; send the file again."); at += c.bytes.length; }
  if (at !== s.sizeBytes) throw new ConflictError("A piece is missing; send the file again.");
  const document = await uploadPatientDocument(scope, userId, {
    bytes: Buffer.concat(chunks.map((c) => Buffer.from(c.bytes))), contentType: s.contentType, originalName: s.originalName, title: s.title, type: s.documentType as PatientDocumentType,
  });
  // The pieces go with the session's completion; a second completion finds it COMPLETED.
  await prisma.$transaction([
    prisma.uploadChunk.deleteMany({ where: { sessionId: s.id } }),
    prisma.uploadSession.update({ where: { id: s.id }, data: { status: "COMPLETED" } }),
  ]);
  return { ...view({ ...s, status: "COMPLETED" }), document };
}

/** The runner: unfinished uploads older than a day are deleted, pieces and all. */
export async function purgeExpiredUploads(opts: { now?: Date; batchSize?: number } = {}) {
  const now = opts.now ?? new Date();
  const ids = (await prisma.uploadSession.findMany({ where: { status: "OPEN", expiresAt: { lte: now } }, select: { id: true }, take: opts.batchSize ?? 200 })).map((s) => s.id);
  if (!ids.length) return { purged: 0 };
  await prisma.uploadSession.deleteMany({ where: { id: { in: ids } } });
  return { purged: ids.length };
}
