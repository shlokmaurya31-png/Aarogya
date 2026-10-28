/**
 * Flagship 1b — the review state of each non-English text (./review.json,
 * written by `npm run docs:notification-review`). A reviewer fluent in the
 * language changes an entry's status to REVIEWED and names themselves; the
 * texts stay machine translations until then (pre-launch item 23).
 */
export const PENDING_REVIEW = "pending native-speaker review";

export interface ReviewEntry {
  key: string;
  language: string;
  /** The English the text was made from: when it changes, the entry is pending again. */
  en: string;
  text: string;
  status: typeof PENDING_REVIEW | "REVIEWED";
  source: string;
  reviewer: string | null;
}
