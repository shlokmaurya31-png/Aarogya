/**
 * Flagship 1b — writes src/lib/notifications/review.json, the review list of
 * every non-English notification and code text: the English it was made from,
 * the text, and its review status. A new or changed entry starts as "pending
 * native-speaker review"; an entry a reviewer marked keeps its status while its
 * English and text are unchanged. texts.test.ts fails when the file is stale.
 *
 * Usage: npm run docs:notification-review
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SUPPORTED_LANGUAGES } from "../src/lib/documents/vocab";
import { TEMPLATE_KEYS, TEMPLATES } from "../src/lib/notifications/texts";
import { PENDING_REVIEW, type ReviewEntry } from "../src/lib/notifications/review";

const FILE = path.join(__dirname, "..", "src", "lib", "notifications", "review.json");
const before: ReviewEntry[] = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : [];
const prior = new Map(before.map((e) => [`${e.key}|${e.language}`, e]));
// The Hindi notification texts predate Flagship 1b (Weeks 4c and 5c); nobody has reviewed them either.
const source = (key: string, lang: string) => (lang === "hi" && key.startsWith("notify.") ? "existing translation (Weeks 4c, 5c)" : "machine translation (Flagship 1b, 2026-10-28)");

const entries: ReviewEntry[] = [];
for (const key of TEMPLATE_KEYS) {
  for (const language of SUPPORTED_LANGUAGES) {
    if (language === "en") continue;
    const en = TEMPLATES[key].en;
    const text = TEMPLATES[key][language];
    const old = prior.get(`${key}|${language}`);
    const same = old && old.en === en && old.text === text;
    entries.push({ key, language, en, text, status: same ? old.status : PENDING_REVIEW, source: same ? old.source : source(key, language), reviewer: same ? old.reviewer ?? null : null });
  }
}
writeFileSync(FILE, JSON.stringify(entries, null, 2) + "\n");
console.log(`${entries.length} entries (${entries.filter((e) => e.status === PENDING_REVIEW).length} pending native-speaker review) → ${path.relative(process.cwd(), FILE)}`);
