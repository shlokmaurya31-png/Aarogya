/**
 * Does an event payload carry `needle` as data? A number counts when it equals
 * the needle; a string when it equals it or, outside identifier fields,
 * contains it; a key when it is the needle. Identifier fields (…Id, …Ids,
 * id) are random cuids, so a short needle like "98" or "hr" can appear in one
 * by chance — matching inside them made "no values" checks flaky (found in
 * Phase 0, part 2). This keeps those checks' intent exact.
 */
export function carries(payload: unknown, needle: string): boolean {
  const isId = (k: string) => k === "id" || /Ids?$/.test(k);
  const walk = (v: unknown, key: string): boolean => {
    if (v === null || v === undefined) return false;
    if (typeof v === "number") return String(v) === needle;
    if (typeof v === "string") return v === needle || (!isId(key) && v.includes(needle));
    if (Array.isArray(v)) return v.some((x) => walk(x, key));
    if (typeof v === "object") return Object.entries(v as Record<string, unknown>).some(([k, x]) => k === needle || walk(x, k));
    return false;
  };
  return walk(payload, "");
}
