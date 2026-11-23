import { prisma } from "@/lib/db";
import { romanizeText } from "./romanize";
import { canonicalMedicinesIn } from "./medicineNames";

/**
 * RAG Phase 3, steps 3.5 and 3.9 — a chunk's index-only terms (RagChunk.shadowText):
 * its Indic words romanised (romanize.ts) and the canonical names of the
 * medicines it names (medicineNames.ts). Never shown, never a source, never
 * sent to a model. Empty string: computed, nothing to add (so the backfill
 * doesn't look at the chunk again).
 */
export function shadowTextFor(chunk: { text: string; heading?: string | null }): string {
  const text = [chunk.heading ?? "", chunk.text].join(" \n ");
  return [romanizeText(text) ?? "", ...canonicalMedicinesIn(text)].filter(Boolean).join(" ").slice(0, 8000);
}

/** The runner's bounded backfill: chunks written before step 3.9 get their shadow text, oldest first. */
export async function backfillShadowText(opts: { batchSize?: number } = {}): Promise<{ updated: number }> {
  const rows = await prisma.ragChunk.findMany({ where: { shadowText: null }, orderBy: { id: "asc" }, take: opts.batchSize ?? 200, select: { id: true, text: true, heading: true } });
  for (const r of rows) await prisma.ragChunk.updateMany({ where: { id: r.id, shadowText: null }, data: { shadowText: shadowTextFor(r) } });
  return { updated: rows.length };
}
