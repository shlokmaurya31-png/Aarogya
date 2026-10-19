/**
 * Week 4b — chunking (docs/RAG_DESIGN.md §5.4): about 400 tokens per chunk,
 * at most 512, with a 60-token overlap; splits at sections first, then
 * paragraphs, then sentences, and never inside a sentence (a single sentence
 * longer than the maximum is its own chunk). Tokens are estimated (a quarter
 * of the characters, at least one per word), deterministic and offline.
 */
export const CHUNK = { target: 400, max: 512, overlap: 60 } as const;

export interface Chunk { heading?: string; text: string; tokenCount: number }

export function estimateTokens(text: string): number {
  const w = text.split(/\s+/).filter(Boolean).length;
  return Math.max(w, Math.ceil(text.length / 4));
}

const ABBREV = /(?:\b(?:Tab|Cap|Syp|Inj|Dr|No|Reg|vs|approx|Fig|St|Mr|Mrs|Ms|e\.g|i\.e)|\d)\.$/i;

/** Sentences, never splitting a decimal ("11.2") or an abbreviation ("Tab. Metformin"). */
export function sentences(paragraph: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const part of paragraph.split(/(?<=[.!?।])\s+/u)) {
    cur = cur ? `${cur} ${part}` : part;
    if (!ABBREV.test(cur)) { out.push(cur); cur = ""; }
  }
  if (cur) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function chunkSections(sections: { heading?: string; text: string }[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const sec of sections) {
    const units = sec.text.split(/\n{2,}|\n/).flatMap((p) => (estimateTokens(p) > CHUNK.target ? sentences(p) : [p.trim()])).filter(Boolean);
    let cur: string[] = [];
    let tokens = 0;
    const flush = () => {
      if (!cur.length) return;
      const text = cur.join("\n");
      chunks.push({ heading: sec.heading, text, tokenCount: estimateTokens(text) });
      // Overlap: carry the tail of the previous chunk, whole units only.
      const tail: string[] = [];
      let t = 0;
      for (let i = cur.length - 1; i >= 0 && t + estimateTokens(cur[i]) <= CHUNK.overlap; i--) { tail.unshift(cur[i]); t += estimateTokens(cur[i]); }
      cur = tail.length < cur.length ? tail : [];
      tokens = cur.reduce((n, u) => n + estimateTokens(u), 0);
    };
    for (const u of units) {
      const n = estimateTokens(u);
      if (tokens + n > CHUNK.max || (tokens >= CHUNK.target && tokens + n > CHUNK.target)) flush();
      cur.push(u);
      tokens += n;
    }
    if (cur.length && !(chunks.length && chunks.at(-1)!.heading === sec.heading && cur.every((u) => chunks.at(-1)!.text.includes(u)))) {
      const text = cur.join("\n");
      chunks.push({ heading: sec.heading, text, tokenCount: estimateTokens(text) });
    }
  }
  return chunks;
}
