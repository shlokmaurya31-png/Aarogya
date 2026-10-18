/**
 * Week 4a: import one version of the WHO INN list (medicine-name protection;
 * src/lib/medicines/reference.ts). One name per line (blank lines and lines
 * starting with # ignored). The version is required and is never edited: an
 * existing version is refused. Localhost only unless
 * MEDICINE_IMPORT_ALLOW_REMOTE=1; Supabase hosts always refused.
 *
 * Usage: npx tsx scripts/import-who-inn.ts --version "List 128 (2022)" --file path/to/inn.txt
 */
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/db";
import { importInnVersion } from "../src/lib/medicines/reference";

async function main() {
  const args = process.argv.slice(2);
  const at = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const version = at("--version");
  const file = at("--file");
  if (!version || !file) throw new Error('Usage: --version "List N (year)" --file names.txt');
  const host = (() => { try { return new URL(process.env.DATABASE_URL ?? "").hostname; } catch { return ""; } })();
  if (/supabase\./.test(host)) throw new Error(`Refusing: ${host} is a Supabase host.`);
  if (!["localhost", "127.0.0.1", "::1"].includes(host) && process.env.MEDICINE_IMPORT_ALLOW_REMOTE !== "1") throw new Error(`Refusing: ${host || "(no host)"} is not localhost.`);
  const names = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  console.log(JSON.stringify(await importInnVersion(version, names)));
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await prisma.$disconnect();
  process.exit(1);
});
