import type { ConfidenceBand } from "@prisma/client";

/**
 * Week 4a — confidence bands (docs/DOCUMENT_PIPELINE_DESIGN.md §7). The
 * thresholds are provisional, to be calibrated on the evaluation set; they can
 * be overridden by DOCUMENT_CONFIDENCE_HIGH / DOCUMENT_CONFIDENCE_LOW within
 * sane bounds (a typo can't make everything HIGH).
 */
const num = (v: string | undefined, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
export const HIGH_THRESHOLD = num(process.env.DOCUMENT_CONFIDENCE_HIGH, 0.85, 0.99, 0.9);
export const LOW_THRESHOLD = num(process.env.DOCUMENT_CONFIDENCE_LOW, 0.5, 0.8, 0.7);

export function bandOf(confidence: number): ConfidenceBand {
  return confidence >= HIGH_THRESHOLD ? "HIGH" : confidence < LOW_THRESHOLD ? "LOW" : "MEDIUM";
}

const ORDER: ConfidenceBand[] = ["LOW", "MEDIUM", "HIGH"];
export function lowerBand(b: ConfidenceBand): ConfidenceBand {
  return ORDER[Math.max(0, ORDER.indexOf(b) - 1)];
}
export function capBand(b: ConfidenceBand, cap: ConfidenceBand): ConfidenceBand {
  return ORDER[Math.min(ORDER.indexOf(b), ORDER.indexOf(cap))];
}
