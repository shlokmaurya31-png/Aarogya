/**
 * Week 4a, step b: medicine-name protection data (src/lib/medicines).
 *
 *   1. The seed imported the curated WHO INN starter version, labelled as such.
 *   2. A version is imported whole and never edited: re-importing it is
 *      refused; an empty list is refused; a new version becomes the latest.
 *   3. The dictionary is NLEM 2022 (no section headings) + the latest INN.
 *   4. A dictionary name is protected in text, so translation can't touch it.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-medicine-reference.ts
 */
import { prisma } from "../src/lib/db";
import { importInnVersion, medicineDictionary, latestInnNames } from "../src/lib/medicines/reference";
import { INN_STARTER, INN_STARTER_VERSION } from "../src/lib/medicines/innStarter";
import { protectedSpans, mask } from "../src/lib/documents/protect";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const refused = <T>(p: Promise<T>) => p.then(() => false, () => true);

async function main() {
  const run = Date.now().toString(36);
  report("The seed imported the curated INN starter version, labelled as curated", (await prisma.medicineReference.count({ where: { source: "WHO_INN", version: INN_STARTER_VERSION } })) === INN_STARTER.length && /curated/.test(INN_STARTER_VERSION));
  report("Re-importing a version is refused (versions are never edited)", await refused(importInnVersion(INN_STARTER_VERSION, ["atorvastatin"])));
  report("An empty list is refused", await refused(importInnVersion(`empty-${run}`, ["", "  "])));
  const v = `gate-${run}`;
  const res = await importInnVersion(v, ["Teneligliptin", "teneligliptin", "Bilastine"]);
  report("A new version imports whole, merging case duplicates", res.imported === 2 && res.duplicatesMerged === 1);
  report("…and becomes the latest", (await latestInnNames()).version === v);
  const dict = await medicineDictionary();
  report("The dictionary is NLEM 2022 plus the latest INN version", dict.names.includes("Metformin") && dict.names.includes("Teneligliptin") && dict.versions.inn === v);
  report("…with no NLEM section headings", !dict.names.some((n) => /^Medicines (used|for|acting|affecting)|^Vitamins and Minerals$/.test(n)));
  const text = "Tab Teneligliptin 20 mg OD";
  const m = mask(text, protectedSpans(text, dict.names));
  report("A dictionary name is masked before translation", !m.masked.includes("Teneligliptin") && m.originals.includes("Teneligliptin"));
  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
