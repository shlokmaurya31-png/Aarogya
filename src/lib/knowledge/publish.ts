import type { Prisma, RagWithdrawReason } from "@prisma/client";
import { prisma } from "@/lib/db";
import { emitDomainEvent } from "@/lib/events/emit";

type Tx = Prisma.TransactionClient;

/**
 * RAG Phase 2, step 2.7 — publish, supersede, expire (docs/RAG_IMPLEMENTATION_PLAN.md §4.2 items 4–5).
 *
 * A knowledge version's index rows are written PENDING by ingestion and are
 * never a retrieval candidate until published. Publishing is one
 * transaction, under a lock on the document: the new version's rows become
 * ACTIVE; the version in force before it is SUPERSEDED, its chunks and
 * embeddings deleted (the RagDocument stays as a tombstone, as in the record
 * index); the document's current version is the new one. A reader sees the
 * old version or the new, never both and never neither. A superseded version
 * can therefore never outrank the current one: it is not in the search.
 *
 * Expiry and withdrawal take a version's rows out of the search the same way;
 * nothing takes its place automatically (the version before it was
 * superseded and stays so). The runner publishes approved versions at their
 * effective date and expires published ones at their expiry date.
 */
export async function retireKnowledgeIndex(tx: Tx, versionId: string, reason: RagWithdrawReason | "SUPERSEDED"): Promise<number> {
  const docs = await tx.ragDocument.findMany({ where: { knowledgeVersionId: versionId, status: { in: ["ACTIVE", "PENDING"] } }, select: { id: true } });
  if (!docs.length) return 0;
  const ids = docs.map((d) => d.id);
  await tx.ragChunk.deleteMany({ where: { documentId: { in: ids } } });
  await tx.ragDocument.updateMany({ where: { id: { in: ids } }, data: reason === "SUPERSEDED" ? { status: "SUPERSEDED" } : { status: "WITHDRAWN", withdrawnAt: new Date(), withdrawnReason: reason } });
  return ids.length;
}

/**
 * Puts an approved, indexed version in force, superseding the one before it.
 * Returns false (and changes nothing) when it can't be: not approved, not
 * indexed, withdrawn, already published, past its expiry, not yet effective,
 * or older than the version in force.
 */
export async function publishKnowledgeVersion(tx: Tx, versionId: string, now: Date, actorUserId?: string): Promise<boolean> {
  const head = await tx.knowledgeDocumentVersion.findUnique({ where: { id: versionId }, select: { documentId: true } });
  if (!head) return false;
  await tx.$queryRaw`SELECT "id" FROM "KnowledgeDocument" WHERE "id" = ${head.documentId} FOR UPDATE`;
  const v = await tx.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: versionId }, include: { document: true } });
  if (v.approvalStatus !== "APPROVED" || v.ingestionStatus !== "INDEXED" || v.withdrawnAt || v.publishedAt) return false;
  if (v.effectiveAt && v.effectiveAt > now) return false;
  if (v.expiresAt && v.expiresAt <= now) return false;
  const prev = v.document.currentVersionId ? await tx.knowledgeDocumentVersion.findUnique({ where: { id: v.document.currentVersionId } }) : null;
  if (prev && prev.version > v.version) return false;

  const rag = await tx.ragDocument.findMany({ where: { knowledgeVersionId: v.id, status: "PENDING" }, select: { id: true } });
  const ragIds = rag.map((r) => r.id);
  await tx.ragDocument.updateMany({ where: { id: { in: ragIds } }, data: { status: "ACTIVE" } });
  await tx.ragChunk.updateMany({ where: { documentId: { in: ragIds } }, data: { status: "ACTIVE" } });
  await tx.ragEmbedding.updateMany({ where: { chunk: { documentId: { in: ragIds } } }, data: { status: "ACTIVE" } });
  await tx.knowledgeDocumentVersion.update({ where: { id: v.id }, data: { publishedAt: now } });
  const tenant = { organizationId: v.document.organizationId, facilityId: v.document.facilityId ?? undefined };
  if (prev) {
    await tx.knowledgeDocumentVersion.update({ where: { id: prev.id }, data: { supersededByVersionId: v.id } });
    await retireKnowledgeIndex(tx, prev.id, "SUPERSEDED");
  }
  await tx.knowledgeDocument.update({ where: { id: v.documentId }, data: { currentVersionId: v.id } });
  await emitDomainEvent(tx, {
    type: "KnowledgeDocumentPublished", aggregateId: v.documentId, ...tenant, actorUserId,
    payload: { documentId: v.documentId, versionId: v.id, version: v.version, ...(prev ? { supersededVersionId: prev.id } : {}) },
  });
  if (prev) await emitDomainEvent(tx, { type: "KnowledgeDocumentSuperseded", aggregateId: v.documentId, ...tenant, actorUserId, payload: { documentId: v.documentId, versionId: prev.id, byVersionId: v.id } });
  return true;
}

/** The runner's sweep: approved versions whose effective date has come are published; published ones past their expiry leave the search. */
export async function sweepKnowledgeSchedule(opts: { now?: Date; batchSize?: number } = {}): Promise<{ published: number; expired: number }> {
  const now = opts.now ?? new Date();
  const take = opts.batchSize ?? 50;
  const due = await prisma.knowledgeDocumentVersion.findMany({
    where: { approvalStatus: "APPROVED", ingestionStatus: "INDEXED", publishedAt: null, withdrawnAt: null, OR: [{ effectiveAt: null }, { effectiveAt: { lte: now } }], AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }] },
    orderBy: [{ effectiveAt: "asc" }, { version: "asc" }], take, select: { id: true },
  });
  let published = 0;
  for (const d of due) if (await prisma.$transaction((tx) => publishKnowledgeVersion(tx, d.id, now))) published++;

  const lapsed = await prisma.$queryRaw<{ id: string }[]>`
    SELECT d."id" FROM "KnowledgeDocument" d JOIN "KnowledgeDocumentVersion" v ON v."id" = d."currentVersionId"
    WHERE v."expiresAt" <= ${now} ORDER BY v."expiresAt", d."id" LIMIT ${take}`;
  let expired = 0;
  for (const doc of lapsed) {
    const done = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "KnowledgeDocument" WHERE "id" = ${doc.id} FOR UPDATE`;
      const d = await tx.knowledgeDocument.findUniqueOrThrow({ where: { id: doc.id } });
      const v = d.currentVersionId ? await tx.knowledgeDocumentVersion.findUnique({ where: { id: d.currentVersionId } }) : null;
      if (!v || !v.expiresAt || v.expiresAt > now) return false;
      await tx.knowledgeDocument.update({ where: { id: d.id }, data: { currentVersionId: null } });
      await retireKnowledgeIndex(tx, v.id, "KNOWLEDGE_EXPIRED");
      await emitDomainEvent(tx, { type: "KnowledgeDocumentExpired", aggregateId: d.id, organizationId: d.organizationId, facilityId: d.facilityId ?? undefined, payload: { documentId: d.id, versionId: v.id } });
      return true;
    });
    if (done) expired++;
  }
  return { published, expired };
}
