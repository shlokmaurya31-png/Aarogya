import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError } from "@/lib/auth/rbac";
import { NLEM_2022 } from "./nlem2022";

/**
 * Week 4a — medicine names that must never be translated or altered
 * (docs/DOCUMENT_PIPELINE_DESIGN.md §5.1): NLEM 2022 (in code) plus the
 * latest imported WHO INN version (MedicineReference). Model tagging adds
 * spans on top (see documents/protect.ts); it can only add protection.
 */

/** Lower-case, single-spaced: the key a name is matched and stored by. */
export function normalizeMedicineName(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The names one NLEM entry protects: the entry itself, the components of a
 * combination ("A (A) + B (B)"), and each alternative in parentheses
 * ("5-aminosalicylic acid (Mesalazine/Mesalaine)").
 */
export function expandEntry(entry: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => { const t = s.trim(); if (t.length >= 3) out.add(t); };
  const parts = entry.split(/\s\+\s/);
  // A combination is also protected whole, as written without the (A)/(B) markers.
  if (parts.length > 1) add(entry.replace(/\s*\([A-Z]\)/g, ""));
  for (const part of parts) {
    const p = part.replace(/\s*\([A-Z]\)\s*$/, "").trim();
    const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(p);
    if (m && !/^[A-Z]$/.test(m[2])) { add(m[1]); for (const alt of m[2].split("/")) add(alt); } else add(p);
  }
  return [...out];
}

export function nlemNames(): string[] {
  return [...new Set(NLEM_2022.flatMap(expandEntry))];
}

/** Imports one WHO INN list version, whole. Refuses an existing version, an empty list, or blank names. */
export async function importInnVersion(version: string, names: readonly string[]) {
  const v = version.trim();
  if (!v) throw new BadRequestError("A version is required (e.g. the WHO cumulative list number).");
  const cleaned = names.map((n) => n.trim()).filter(Boolean);
  if (cleaned.length === 0) throw new BadRequestError("The list is empty.");
  if (cleaned.length !== names.filter((n) => n.trim()).length) throw new BadRequestError("Blank names.");
  if (await prisma.medicineReference.count({ where: { source: "WHO_INN", version: v } })) throw new ConflictError(`WHO INN version "${v}" is already imported; versions are never edited.`);
  const byKey = new Map(cleaned.map((n) => [normalizeMedicineName(n), n]));
  await prisma.medicineReference.createMany({ data: [...byKey].map(([normalized, name]) => ({ source: "WHO_INN" as const, version: v, name, normalized })) });
  return { version: v, imported: byKey.size, duplicatesMerged: cleaned.length - byKey.size };
}

/** The latest imported WHO INN version's names (by import time), or none. */
export async function latestInnNames(): Promise<{ version: string | null; names: string[] }> {
  const latest = await prisma.medicineReference.findFirst({ where: { source: "WHO_INN" }, orderBy: { createdAt: "desc" }, select: { version: true } });
  if (!latest) return { version: null, names: [] };
  const rows = await prisma.medicineReference.findMany({ where: { source: "WHO_INN", version: latest.version }, select: { name: true } });
  return { version: latest.version, names: rows.map((r) => r.name) };
}

/** The full protected-name dictionary: NLEM 2022 + the latest WHO INN version. */
export async function medicineDictionary(): Promise<{ names: string[]; versions: { nlem: string; inn: string | null } }> {
  const inn = await latestInnNames();
  return { names: [...new Set([...nlemNames(), ...inn.names])], versions: { nlem: "NLEM 2022", inn: inn.version } };
}
