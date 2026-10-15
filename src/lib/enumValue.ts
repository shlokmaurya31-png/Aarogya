import { BadRequestError } from "@/lib/auth/rbac";

/**
 * Status/priority columns are Prisma enums (docs/POSTGRES_CUTOVER_REPORT.md §8).
 * Values arriving as text (query strings, request bodies, service inputs) are
 * checked here, so an unknown value is a 400 rather than a database error or a
 * filter that silently matches nothing.
 */
export function parseEnum<E extends Record<string, string>>(e: E, value: unknown, label: string): E[keyof E] {
  if (typeof value === "string" && (Object.values(e) as string[]).includes(value)) return value as E[keyof E];
  throw new BadRequestError(`${label} must be one of ${Object.values(e).join(", ")}.`);
}

/** As parseEnum, but absent (undefined, null or "") stays undefined. */
export function parseOptionalEnum<E extends Record<string, string>>(e: E, value: unknown, label: string): E[keyof E] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return parseEnum(e, value, label);
}

/** A typed list of enum values, for `in` / `notIn` filters. */
export function enumList<E extends Record<string, string>>(e: E, values: readonly string[]): E[keyof E][] {
  return values.map((v) => parseEnum(e, v, "value"));
}
