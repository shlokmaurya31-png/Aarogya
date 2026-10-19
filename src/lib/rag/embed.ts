import { Prisma, type RagEmbeddingSpace } from "@prisma/client";
import { prisma } from "@/lib/db";
import { embeddingProviderFor } from "@/lib/ai/embeddings";
import type { AiPermit } from "@/lib/ai/record/types";
import { vectorLiteral } from "./search";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Week 4b — embedding the index (docs/RAG_DESIGN.md §3.2a, §5.4, §5.8).
 * A chunk is embedded with its context line first ("[Lab result · CBC ·
 * 2026-10-14 · verified]"), then its heading and text. Embeddings are
 * computed outside any transaction (the provider may be slow); the write is
 * idempotent on (chunk, model, version).
 */
export function chunkEmbeddingText(c: { context: string; heading?: string | null; text: string }): string {
  return [c.context, c.heading, c.text].filter(Boolean).join("\n");
}

export async function activeSpace(db: Db = prisma): Promise<RagEmbeddingSpace> {
  return db.ragEmbeddingSpace.findFirstOrThrow({ where: { status: "ACTIVE" } });
}

/** The active space and any being built: a new chunk is embedded in each, so a re-embed converges (§5.8). */
export async function writableSpaces(db: Db = prisma): Promise<RagEmbeddingSpace[]> {
  return db.ragEmbeddingSpace.findMany({ where: { status: { in: ["ACTIVE", "BUILDING"] } }, orderBy: { createdAt: "asc" } });
}

export interface EmbeddingRow {
  chunkId: string;
  vector: number[];
  ownerType: "FACILITY_PATIENT" | "PERSON";
  facilityId: string | null;
  patientId: string | null;
  personId: string | null;
}

export async function computeEmbeddings(space: RagEmbeddingSpace, texts: string[], permit: AiPermit): Promise<number[][]> {
  const provider = embeddingProviderFor(space);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) out.push(...(await provider.embed(texts.slice(i, i + 64), "document", permit)));
  return out;
}

/** Inserts embeddings for one space; an existing (chunk, model, version) is left as it is. */
export async function writeEmbeddings(db: Db, space: RagEmbeddingSpace, rows: EmbeddingRow[]): Promise<number> {
  if (!rows.length) return 0;
  const values = rows.map((r) => Prisma.sql`(${`emb_${space.id}_${r.chunkId}`}, ${r.chunkId}, ${space.embeddingModel}, ${space.embeddingVersion}, ${space.dims}, ${vectorLiteral(r.vector)}::halfvec, ${r.ownerType}::"RagOwnerType", ${r.facilityId}, ${r.patientId}, ${r.personId})`);
  return db.$executeRaw`INSERT INTO "RagEmbedding" ("id", "chunkId", "embeddingModel", "embeddingVersion", "dims", "embedding", "ownerType", "facilityId", "patientId", "personId")
    VALUES ${Prisma.join(values)} ON CONFLICT ("chunkId", "embeddingModel", "embeddingVersion") DO NOTHING`;
}
