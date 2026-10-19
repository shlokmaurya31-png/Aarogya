import type { RagEmbeddingSpace } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ConflictError, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { aiAssistancePermit } from "@/lib/ai/realData";
import { embeddingProviderFor } from "@/lib/ai/embeddings";
import { chunkEmbeddingText, computeEmbeddings, writeEmbeddings, type EmbeddingRow } from "./embed";
import { removeOwnerIndex } from "./remove";

/**
 * Week 4b — re-embedding is a background job, not a schema migration
 * (docs/RAG_DESIGN.md §5.8, decision 8):
 *   1. startReembed: a BUILDING space for the new {model, version};
 *   2. reembedBatch (the runner, or npm run rag:reembed): ACTIVE chunks
 *      without an embedding in that space, in id order, rate-limited by the
 *      batch size, idempotent on (chunk, model, version); an owner the AI
 *      gate now refuses is removed from the index instead; new chunks are
 *      embedded in every BUILDING space as they are indexed, so it converges;
 *   3. activateEmbeddingSpace: only at 100% coverage; the old space is
 *      RETIRED in the same transaction (audited, RagEmbeddingSpaceChanged);
 *   4. purgeRetiredEmbeddings: after the grace period, the old rows go.
 * No step changes the schema: a new dimension is just rows.
 */
const PROVIDERS = ["mock", "voyage", "india-hosted"] as const;

async function announce(space: RagEmbeddingSpace, previous: RagEmbeddingSpace["status"] | null, actorUserId: string | null, tx: Parameters<typeof emitDomainEvent>[0]) {
  await emitDomainEvent(tx, {
    type: "RagEmbeddingSpaceChanged", aggregateId: space.id, actorUserId,
    payload: { spaceId: space.id, embeddingModel: space.embeddingModel, embeddingVersion: space.embeddingVersion, provider: space.provider, dims: space.dims, status: space.status, previous },
  });
}

/** A space to build: idempotent on {model, version}; the provider must be able to embed for it now. */
export async function startReembed(input: { embeddingModel: string; embeddingVersion: number; provider: string; dims: number; byUserId?: string | null }): Promise<RagEmbeddingSpace> {
  if (!(PROVIDERS as readonly string[]).includes(input.provider)) throw new BadRequestError(`provider must be one of ${PROVIDERS.join(", ")}.`);
  if (!Number.isInteger(input.embeddingVersion) || input.embeddingVersion < 1 || !Number.isInteger(input.dims) || input.dims < 1) throw new BadRequestError("version and dims must be positive integers.");
  // Refuses an unavailable provider (no key, deferred) before anything is written.
  embeddingProviderFor(input);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.ragEmbeddingSpace.findUnique({ where: { embeddingModel_embeddingVersion: { embeddingModel: input.embeddingModel, embeddingVersion: input.embeddingVersion } } });
    if (existing) {
      if (existing.provider !== input.provider || existing.dims !== input.dims) throw new ConflictError("That model and version already exist with another provider or dimension.");
      return existing;
    }
    const space = await tx.ragEmbeddingSpace.create({ data: { embeddingModel: input.embeddingModel, embeddingVersion: input.embeddingVersion, provider: input.provider, dims: input.dims, status: "BUILDING" } });
    await announce(space, null, input.byUserId ?? null, tx);
    return space;
  });
}

/** One batch: ACTIVE chunks still missing from the space, embedded and written. */
export async function reembedBatch(input: { spaceId: string; batchSize?: number }): Promise<{ embedded: number; removed: number; remaining: number }> {
  const space = await prisma.ragEmbeddingSpace.findUnique({ where: { id: input.spaceId } });
  if (!space) throw new NotFoundError("Embedding space not found.");
  if (space.status === "RETIRED") return { embedded: 0, removed: 0, remaining: 0 };
  const chunks = await prisma.ragChunk.findMany({
    where: { status: "ACTIVE", embeddings: { none: { embeddingModel: space.embeddingModel, embeddingVersion: space.embeddingVersion } } },
    orderBy: { id: "asc" }, take: input.batchSize ?? 200,
    select: { id: true, context: true, heading: true, text: true, ownerType: true, facilityId: true, patientId: true, personId: true },
  });
  let embedded = 0, removed = 0;
  // One permit per owner: the real-data switch and the person's AI consent decide, as when indexing.
  const owners = new Map<string, typeof chunks>();
  for (const c of chunks) {
    const key = c.ownerType === "PERSON" ? `P:${c.personId}` : `F:${c.facilityId}:${c.patientId}`;
    owners.set(key, [...(owners.get(key) ?? []), c]);
  }
  for (const group of owners.values()) {
    const c0 = group[0];
    const gate = await aiAssistancePermit(c0.ownerType === "PERSON" ? { personId: c0.personId! } : { facilityId: c0.facilityId!, patientId: c0.patientId! });
    // An owner the AI may not use has no place in the index: removed, not skipped (so it can't block coverage).
    if (!gate.allowed) { removed += await removeOwnerIndex(prisma, c0.ownerType === "PERSON" ? { personId: c0.personId! } : { facilityId: c0.facilityId!, patientId: c0.patientId! }); continue; }
    const vectors = await computeEmbeddings(space, group.map(chunkEmbeddingText), gate.permit);
    const rows: EmbeddingRow[] = group.map((c, i) => ({ chunkId: c.id, vector: vectors[i], ownerType: c.ownerType, facilityId: c.facilityId, patientId: c.patientId, personId: c.personId }));
    embedded += await writeEmbeddings(prisma, space, rows);
  }
  const remaining = await prisma.ragChunk.count({ where: { status: "ACTIVE", embeddings: { none: { embeddingModel: space.embeddingModel, embeddingVersion: space.embeddingVersion } } } });
  return { embedded, removed, remaining };
}

export async function embeddingCoverage(spaceId: string): Promise<{ activeChunks: number; embedded: number; ratio: number }> {
  const space = await prisma.ragEmbeddingSpace.findUniqueOrThrow({ where: { id: spaceId } });
  const activeChunks = await prisma.ragChunk.count({ where: { status: "ACTIVE" } });
  const embedded = await prisma.ragChunk.count({ where: { status: "ACTIVE", embeddings: { some: { embeddingModel: space.embeddingModel, embeddingVersion: space.embeddingVersion } } } });
  return { activeChunks, embedded, ratio: activeChunks === 0 ? 1 : embedded / activeChunks };
}

/** The switch (§5.8 step 2): only at 100% coverage; the previous space is retired in the same transaction. */
export async function activateEmbeddingSpace(input: { spaceId: string; byUserId: string }): Promise<RagEmbeddingSpace> {
  const cov = await embeddingCoverage(input.spaceId);
  if (cov.ratio < 1) throw new ConflictError(`The space covers ${cov.embedded} of ${cov.activeChunks} active chunks; finish the re-embed first.`);
  const space = await prisma.$transaction(async (tx) => {
    const target = await tx.ragEmbeddingSpace.findUniqueOrThrow({ where: { id: input.spaceId } });
    if (target.status !== "BUILDING") throw new ConflictError(`The space is ${target.status}.`);
    const missing = await tx.ragChunk.count({ where: { status: "ACTIVE", embeddings: { none: { embeddingModel: target.embeddingModel, embeddingVersion: target.embeddingVersion } } } });
    if (missing > 0) throw new ConflictError("New chunks arrived without an embedding in this space; run another batch.");
    const now = new Date();
    for (const old of await tx.ragEmbeddingSpace.findMany({ where: { status: "ACTIVE" } })) {
      const retired = await tx.ragEmbeddingSpace.update({ where: { id: old.id }, data: { status: "RETIRED", retiredAt: now } });
      await announce(retired, "ACTIVE", input.byUserId, tx);
    }
    const active = await tx.ragEmbeddingSpace.update({ where: { id: target.id }, data: { status: "ACTIVE", activatedAt: now, activatedByUserId: input.byUserId } });
    await announce(active, "BUILDING", input.byUserId, tx);
    return active;
  });
  await recordAuditEvent("ai.embedding_space.activated", input.byUserId, { spaceId: space.id, embeddingModel: space.embeddingModel, embeddingVersion: space.embeddingVersion });
  return space;
}

/** After the grace period, a retired space's embeddings are deleted (§5.8 step 3). */
export async function purgeRetiredEmbeddings(opts: { graceDays?: number; now?: Date } = {}): Promise<{ deleted: number }> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - (opts.graceDays ?? 7) * 86_400_000);
  let deleted = 0;
  for (const s of await prisma.ragEmbeddingSpace.findMany({ where: { status: "RETIRED", retiredAt: { lt: cutoff } } })) {
    deleted += (await prisma.ragEmbedding.deleteMany({ where: { embeddingModel: s.embeddingModel, embeddingVersion: s.embeddingVersion } })).count;
  }
  return { deleted };
}

/** The runner's share: one bounded batch for each space being built. */
export async function runReembedTick(opts: { batchSize?: number } = {}): Promise<{ embedded: number }> {
  let embedded = 0;
  for (const s of await prisma.ragEmbeddingSpace.findMany({ where: { status: "BUILDING" } })) {
    try { embedded += (await reembedBatch({ spaceId: s.id, batchSize: opts.batchSize ?? 100 })).embedded; } catch { /* the next tick tries again */ }
  }
  return { embedded };
}
