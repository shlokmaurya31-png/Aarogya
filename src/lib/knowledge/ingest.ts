import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { emitDomainEvent } from "@/lib/events/emit";
import { RetryableEventError } from "@/lib/events/types";
import { EmbeddingUnavailableError } from "@/lib/ai/embeddings/types";
import { knowledgePermit } from "@/lib/ai/realData";
import { getStorageAdapter } from "@/lib/storage";
import { knowledgeEmbeddingText, writableSpaces, writeEmbeddings } from "@/lib/rag/embed";
import { cachedKnowledgeEmbeddings } from "@/lib/rag/embedCache";
import { parseKnowledgeFile, documentText, KnowledgeParseError } from "./parse";
import { chunkKnowledge } from "./chunk";
import { scanIdentifiers } from "./identifiers";
import type { KnowledgeFormat } from "./formats";

type Tx = Prisma.TransactionClient;

/**
 * RAG Phase 2, step 2.6 — the knowledge-ingest consumer's work: one version
 * read, chunked, embedded through the cache and written, on the bulk lane.
 *
 *   - Idempotent: a version already indexed (or out of use) is nothing to do,
 *     and no provider is called; a replayed event creates nothing.
 *   - A partly processed version is never indexed: the RagDocument, its chunks
 *     and their embeddings are written in ONE transaction with the version's
 *     INDEXED status, all PENDING (never a retrieval candidate until published).
 *     The statuses before that (PARSING, EMBEDDING) are markers for the admin view.
 *   - Embeddings come from the knowledge cache (identical text is embedded
 *     once, across documents) with a knowledge permit (no person; external
 *     providers only if the organisation turned that on).
 *   - Failures: a file that can't be read ends FAILED with a closed code and
 *     can be re-run; a provider or storage outage is retried by the dispatcher
 *     (with backoff), and after MAX_ATTEMPTS ends FAILED as well.
 */
export const MAX_ATTEMPTS = 5;
export type IngestOutcome = "INDEXED" | "UNCHANGED" | "FAILED" | "SKIPPED";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type FailCode = "UNREADABLE" | "NO_TEXT_LAYER" | "NO_TEXT" | "TOO_MANY_PAGES" | "CONTAINS_IDENTIFIERS" | "PROVIDER_UNAVAILABLE" | "STORAGE_UNAVAILABLE";

async function fail(versionId: string, code: FailCode): Promise<IngestOutcome> {
  await prisma.$transaction(async (tx) => {
    const v = await tx.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: versionId }, include: { document: true } });
    if (v.ingestionStatus === "INDEXED") return;
    await tx.knowledgeDocumentVersion.update({ where: { id: v.id }, data: { ingestionStatus: "FAILED", ingestionError: code } });
    await emitDomainEvent(tx, {
      type: "KnowledgeDocumentIngestionFailed", aggregateId: v.documentId, organizationId: v.document.organizationId, facilityId: v.document.facilityId ?? undefined,
      payload: { documentId: v.documentId, versionId: v.id, code, attempts: v.ingestionAttempts },
    });
  });
  return "FAILED";
}

export async function ingestKnowledgeVersion(versionId: string, opts: { eventId?: string; now?: Date } = {}): Promise<IngestOutcome> {
  const v = await prisma.knowledgeDocumentVersion.findUnique({ where: { id: versionId }, include: { document: true } });
  if (!v) return "SKIPPED";
  if (v.ingestionStatus === "INDEXED" || (await prisma.ragDocument.count({ where: { knowledgeVersionId: v.id } })) > 0) return "UNCHANGED";
  if (v.ingestionStatus === "FAILED" || v.withdrawnAt || v.approvalStatus === "REJECTED") return "SKIPPED";
  const doc = v.document;

  // Claimed: one more attempt, the start time, PARSING.
  await prisma.knowledgeDocumentVersion.updateMany({ where: { id: v.id, ingestionStatus: { notIn: ["INDEXED", "FAILED"] } }, data: { ingestionStatus: "PARSING", ingestionAttempts: { increment: 1 }, ingestionStartedAt: v.ingestionStartedAt ?? opts.now ?? new Date() } });
  const attempts = v.ingestionAttempts + 1;
  const retryOrFail = async (code: "PROVIDER_UNAVAILABLE" | "STORAGE_UNAVAILABLE", detail: string): Promise<IngestOutcome> => {
    if (attempts >= MAX_ATTEMPTS) return fail(v.id, code);
    throw new RetryableEventError(`Knowledge ingestion: ${detail}`, code);
  };

  let bytes: Buffer;
  try {
    bytes = (await getStorageAdapter().get(v.storageRef)).bytes;
  } catch {
    return retryOrFail("STORAGE_UNAVAILABLE", "storage unavailable");
  }
  let parsed;
  try {
    parsed = await parseKnowledgeFile((v.format ?? "TEXT") as KnowledgeFormat, bytes);
  } catch (err) {
    if (err instanceof KnowledgeParseError) return fail(v.id, err.code);
    if (err instanceof SyntaxError) return fail(v.id, "UNREADABLE");
    throw err;
  }
  // Checked at upload; checked again here, so no path indexes an identifier-bearing file.
  if (scanIdentifiers(documentText(parsed)).refused.length) return fail(v.id, "CONTAINS_IDENTIFIERS");
  const chunks = chunkKnowledge(parsed);
  if (!chunks.length) return fail(v.id, "NO_TEXT");
  await prisma.$transaction(async (tx) => {
    await tx.knowledgeDocumentVersion.updateMany({ where: { id: v.id, ingestionStatus: "PARSING" }, data: { ingestionStatus: "EMBEDDING", pageCount: parsed.pageCount ?? undefined } });
    await emitDomainEvent(tx, {
      type: "KnowledgeDocumentVersionParsed", aggregateId: doc.id, organizationId: doc.organizationId, facilityId: doc.facilityId ?? undefined,
      payload: { documentId: doc.id, versionId: v.id, ...(parsed.pageCount ? { pages: parsed.pageCount } : {}), chunks: chunks.length },
    });
  });

  const context = (sectionPath: string | null) => `[Reference · ${doc.title} · version ${v.version}${sectionPath ? ` · ${sectionPath}` : ""}]`;
  const texts = chunks.map(knowledgeEmbeddingText);
  const spaces = await writableSpaces();
  const active = spaces.find((s) => s.status === "ACTIVE")!;
  const permit = knowledgePermit(doc.organizationId);
  let vectors: number[][][];
  let hits = 0, embedded = 0;
  try {
    vectors = [];
    for (const s of spaces) {
      const r = await cachedKnowledgeEmbeddings(s, texts, permit);
      vectors.push(r.vectors);
      // Chunks whose vector was not computed now: found in the cache, or the same text as another chunk.
      if (s.id === active.id) { embedded = r.embedded; hits = texts.length - r.embedded; }
    }
  } catch (err) {
    if (err instanceof EmbeddingUnavailableError) return retryOrFail("PROVIDER_UNAVAILABLE", `embedding provider unavailable (${err.code})`);
    throw err;
  }

  const contentHash = sha(JSON.stringify(texts));
  const written = await prisma.$transaction(async (tx: Tx) => {
    await tx.$queryRaw`SELECT "id" FROM "KnowledgeDocument" WHERE "id" = ${doc.id} FOR UPDATE`;
    const now = await tx.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: v.id } });
    if (now.ingestionStatus === "INDEXED" || now.ingestionStatus === "FAILED" || now.withdrawnAt || now.approvalStatus === "REJECTED") return false;
    if (await tx.ragDocument.count({ where: { knowledgeVersionId: v.id } })) return false;
    const common = {
      ownerType: "KNOWLEDGE" as const, organizationId: doc.organizationId, facilityId: doc.facilityId, accessClass: doc.accessClass,
      categories: [], origin: "VERIFIED" as const, audience: "STAFF_ONLY" as const, status: "PENDING" as const,
      sourceType: "KNOWLEDGE_DOCUMENT" as const, sourceId: doc.id, recordedAt: v.uploadedAt,
    };
    const rd = await tx.ragDocument.create({
      data: {
        ownerType: common.ownerType, organizationId: common.organizationId, facilityId: common.facilityId, accessClass: common.accessClass, knowledgeVersionId: v.id,
        sourceType: common.sourceType, sourceId: doc.id, sourceVersion: v.version, origin: common.origin, originalLanguage: v.language, contentHash,
        categories: [], audience: common.audience, title: doc.title, recordedAt: v.uploadedAt, status: "PENDING",
        indexedFromEventId: opts.eventId ?? null, embeddingModel: active.embeddingModel, embeddingDim: active.dims,
      },
    });
    const created = await tx.ragChunk.createManyAndReturn({
      data: chunks.map((c, i) => ({
        documentId: rd.id, chunkNo: i, ...common, context: context(c.sectionPath), heading: c.heading, text: c.text, tokenCount: c.tokenCount,
        language: v.language, pageNumber: c.pageNumber, sectionPath: c.sectionPath,
      })),
      select: { id: true, chunkNo: true },
    });
    created.sort((a, b) => a.chunkNo - b.chunkNo);
    for (const [si, space] of spaces.entries()) {
      await writeEmbeddings(tx, space, created.map((c, i) => ({ chunkId: c.id, vector: vectors[si][i], ownerType: "KNOWLEDGE", facilityId: doc.facilityId, patientId: null, personId: null })));
    }
    await tx.knowledgeDocumentVersion.update({ where: { id: v.id }, data: { ingestionStatus: "INDEXED", indexedAt: new Date(), chunkCount: chunks.length, cacheHitCount: hits, embeddedCount: embedded, ingestionError: null } });
    await emitDomainEvent(tx, {
      type: "KnowledgeDocumentVersionIndexed", aggregateId: doc.id, organizationId: doc.organizationId, facilityId: doc.facilityId ?? undefined,
      payload: { documentId: doc.id, versionId: v.id, chunks: chunks.length, cacheHits: hits, embedded },
    });
    return true;
  }, { timeout: 60_000 });
  return written ? "INDEXED" : "UNCHANGED";
}

