/**
 * Substring filter for user-typed search text.
 *
 * Postgres compares strings case-sensitively, so a bare `{ contains: q }`
 * finds "Rohit" but not "rohit". (SQLite's LIKE ignored ASCII case, which
 * hid this until the Postgres cutover.) Every search box should match
 * regardless of case, so search filters go through this helper.
 */
export function textContains(q: string) {
  return { contains: q, mode: "insensitive" as const };
}
