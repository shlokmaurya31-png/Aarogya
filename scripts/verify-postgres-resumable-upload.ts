/**
 * Flagship 5, step 6c — resumable uploads (docs/MOBILE_ACCESSIBILITY.md §4).
 *
 *   1. Starting checks the type and size; nothing is stored yet.
 *   2. Pieces arrive in order; a piece sent twice (its answer lost) is taken
 *      once; a piece out of order is refused with how much arrived.
 *   3. Completing before every byte is here is refused; after, the document is
 *      the exact file (checksum), created as a one-shot upload is (its event),
 *      and the pieces are deleted; completing twice is once.
 *   4. Another account can't see, add to or complete it.
 *   5. An unfinished upload is deleted after a day.
 */
import "./lib/gateBootstrap";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../src/lib/db";
import { CHUNK_BYTES, completeUpload, purgeExpiredUploads, putUploadChunk, startUpload, uploadProgress } from "../src/lib/patient/experience/resumableUpload";
import { notFound, refused, reporter, sharer } from "./lib/shareFixture";

const { report, done } = reporter();

async function main() {
  const P = await sharer();
  const other = await sharer();
  const scope = { patientId: P.pune, patientIds: [P.pune], facilityId: "fac-amc-pune", isSelf: true, allowedClasses: new Set<string>() } as unknown as Parameters<typeof completeUpload>[0];
  const file = Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(CHUNK_BYTES * 2 + 1000), Buffer.from("\n%%EOF\n")]);
  const piece = (i: number) => file.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);

  // 1. Starting.
  report("Only PDFs and photos; not empty; not over the bucket's limit",
    (await refused(startUpload(P.userId, { name: "x.exe", contentType: "application/x-msdownload", sizeBytes: 10 }))) && (await refused(startUpload(P.userId, { name: "a.pdf", contentType: "application/pdf", sizeBytes: 0 })))
      && (await refused(startUpload(P.userId, { name: "a.pdf", contentType: "application/pdf", sizeBytes: 16 * 1024 * 1024 }))));
  const s = await startUpload(P.userId, { name: "report.pdf", contentType: "application/pdf", sizeBytes: file.length, title: "Resumable gate report" });
  report("Started: nothing stored yet, in pieces of 256 KB", s.receivedBytes === 0 && s.chunkBytes === CHUNK_BYTES && (await prisma.uploadChunk.count({ where: { sessionId: s.uploadId } })) === 0);

  // 2. Pieces.
  let v = await putUploadChunk(P.userId, s.uploadId, 0, piece(0));
  report("The first piece arrives", v.receivedBytes === CHUNK_BYTES);
  v = await putUploadChunk(P.userId, s.uploadId, 0, piece(0));
  report("The same piece again (its answer was lost): taken once", v.receivedBytes === CHUNK_BYTES && (await prisma.uploadChunk.count({ where: { sessionId: s.uploadId } })) === 1);
  report("A piece out of order is refused, with how much arrived", await putUploadChunk(P.userId, s.uploadId, CHUNK_BYTES * 2, piece(2)).then(() => false, (e) => /Expected the piece at 262144/.test(String(e?.message))));
  report("A piece bigger than 256 KB, or past the end, is refused",
    (await refused(putUploadChunk(P.userId, s.uploadId, CHUNK_BYTES, Buffer.alloc(CHUNK_BYTES + 1)))) && (await refused(putUploadChunk(P.userId, s.uploadId, CHUNK_BYTES, Buffer.alloc(file.length)))));
  report("Completing early is refused", await refused(completeUpload(scope, P.userId, s.uploadId)));

  // 4. Another account.
  report("Another account can't see it, add to it or complete it: 404",
    (await notFound(uploadProgress(other.userId, s.uploadId))) && (await notFound(putUploadChunk(other.userId, s.uploadId, CHUNK_BYTES, piece(1)))) && (await notFound(completeUpload(scope, other.userId, s.uploadId))));

  // 3. Completing.
  await putUploadChunk(P.userId, s.uploadId, CHUNK_BYTES, piece(1));
  v = await putUploadChunk(P.userId, s.uploadId, CHUNK_BYTES * 2, piece(2));
  report("After a drop, the phone learns how much arrived", (await uploadProgress(P.userId, s.uploadId)).receivedBytes === file.length && v.receivedBytes === file.length);
  const c = await completeUpload(scope, P.userId, s.uploadId);
  const docRow = c.document ? await prisma.personDocument.findUnique({ where: { id: c.document.id } }) : null;
  report("Completed: the document is the exact file, the person's own, with its event",
    !!docRow && docRow.personId === P.personId && docRow.sha256 === createHash("sha256").update(file).digest("hex") && docRow.title === "Resumable gate report"
      && (await prisma.domainEventOutbox.count({ where: { eventType: "PersonDocumentUploaded", aggregateId: docRow.id } })) === 1);
  report("…and the pieces are deleted", (await prisma.uploadChunk.count({ where: { sessionId: s.uploadId } })) === 0);
  const again = await completeUpload(scope, P.userId, s.uploadId);
  report("Completing again is once: no second document", again.complete && again.document === null && (await prisma.personDocument.count({ where: { personId: P.personId, title: "Resumable gate report" } })) === 1);

  // 5. Unfinished uploads expire.
  const stale = await startUpload(P.userId, { name: "late.pdf", contentType: "application/pdf", sizeBytes: file.length });
  await putUploadChunk(P.userId, stale.uploadId, 0, piece(0));
  await prisma.uploadSession.update({ where: { id: stale.uploadId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  report("An expired upload can't be continued", await notFound(putUploadChunk(P.userId, stale.uploadId, CHUNK_BYTES, piece(1))));
  const purged = await purgeExpiredUploads();
  report("…and the runner deletes it, pieces and all", purged.purged >= 1 && !(await prisma.uploadSession.findUnique({ where: { id: stale.uploadId } })) && (await prisma.uploadChunk.count({ where: { sessionId: stale.uploadId } })) === 0);
  report("A completed upload is never purged", !!(await prisma.uploadSession.findUnique({ where: { id: s.uploadId } })));

  await done();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
