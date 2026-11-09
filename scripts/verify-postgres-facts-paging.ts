/**
 * Flagship 3c — "facts to confirm" in pages (/api/patient/person/facts,
 * src/lib/documents/review.ts factsPage).
 *
 *   1. The first page is small (20) and LOW confidence first, and carries the
 *      total and the counts by band; other statuses are not counted.
 *   2. Walking every page gives exactly the full list in review order (band,
 *      then oldest first, then id), ties at a page's edge included: nothing
 *      twice, nothing skipped.
 *   3. Deciding facts already shown, between pages, skips nothing unseen.
 *   4. A cursor that isn't one is refused; the processing filter holds;
 *      another person's login (no proxy grant) can't page this person's facts.
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { PDFDocument } from "pdf-lib";
import { prisma } from "../src/lib/db";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { uploadPersonDocument } from "../src/lib/person/documents";
import { createRun } from "../src/lib/documents/pipelineState";
import { FACTS_FIRST_PAGE, factsPage } from "../src/lib/documents/review";
import { tag } from "./lib/shareFixture";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const BANDS = ["LOW", "MEDIUM", "HIGH"] as const;

async function account(n: number) {
  const a = await registerPatientAccount({ fullName: `Facts ${tag} ${n}`, email: `facts-${tag}-${n}@verify.aarogya`, passwordHash: "x", sex: "F", dob: new Date("1979-02-02") });
  if (a.status !== "LINKED_NEW") throw new Error(`fixture: ${a.status}`);
  return { userId: a.userId, personId: (await prisma.personAccount.findUniqueOrThrow({ where: { userId: a.userId } })).personId };
}

async function walk(userId: string, opts: { processingId?: string } = {}, between?: (seen: string[]) => Promise<void>) {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const p: Awaited<ReturnType<typeof factsPage>> = await factsPage(userId, undefined, { ...opts, cursor });
    ids.push(...p.facts.map((f) => f.id));
    cursor = p.nextCursor;
    pages += 1;
    if (between) await between(ids);
  } while (cursor && pages < 100);
  return { ids, pages };
}

async function main() {
  const me = await account(1);
  const other = await account(2);
  const pdf = await PDFDocument.create(); pdf.addPage([100, 100]);
  const run = async () => {
    const doc = await uploadPersonDocument(me.userId, { bytes: Buffer.from(await pdf.save()), contentType: "application/pdf", originalName: `f-${tag}.pdf`, title: "Facts paging", type: "REPORT" });
    return prisma.$transaction((tx) => createRun(tx, { personId: me.personId, documentId: doc.id, targetLanguage: "en" }));
  };
  const r1 = await run();
  const r2 = await run();
  // 130 pending facts across the bands, in blocks of five sharing one createdAt (ties at the page edges), and 5 already confirmed.
  const t0 = Date.now() - 3_600_000;
  const rows = Array.from({ length: 130 }, (_, i) => ({
    id: `fp-${tag}-${String(i).padStart(3, "0")}`, processingId: i % 3 === 0 ? r2.id : r1.id, personId: me.personId, factType: "LAB_VALUE" as const,
    value: { analyte: `Analyte ${i}`, value: String(i), unit: "mg/dL" }, confidence: 0.5, confidenceBand: BANDS[i % 3], pageNo: 1,
    sourceText: `Analyte ${i} ${i} mg/dL`, exactCopyCheck: "PASSED" as const, createdAt: new Date(t0 + Math.floor(i / 5) * 1000),
  }));
  await prisma.extractedFact.createMany({ data: rows });
  await prisma.extractedFact.createMany({ data: Array.from({ length: 5 }, (_, i) => ({ ...rows[i], id: `fp-${tag}-done-${i}`, reviewStatus: "CONFIRMED" as const, reviewedAt: new Date(), reviewedByUserId: me.userId, reviewedVia: "SELF" as const })) });
  const order = (xs: typeof rows) => [...xs].sort((a, b) => BANDS.indexOf(a.confidenceBand) - BANDS.indexOf(b.confidenceBand) || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => r.id);
  const expected = order(rows);

  // 1. The first page.
  const first = await factsPage(me.userId, undefined, {});
  report("The first page is small", first.facts.length === FACTS_FIRST_PAGE, `${first.facts.length}`);
  report("…least confident first", first.facts.every((f) => f.confidenceBand === "LOW"));
  report("…and carries the total and the counts by band (pending only)", "total" in first && first.total === 130 && first.byBand.LOW === 44 && first.byBand.MEDIUM === 43 && first.byBand.HIGH === 43, JSON.stringify("byBand" in first ? first.byBand : {}));

  // 2. Every page, in order.
  const all = await walk(me.userId);
  report("Walking every page gives exactly the full list, in review order", JSON.stringify(all.ids) === JSON.stringify(expected), `${all.ids.length} in ${all.pages} pages`);
  report("…nothing twice", new Set(all.ids).size === all.ids.length);

  // 3. Decisions between pages.
  const decided = new Set<string>();
  const live = await walk(me.userId, {}, async (seen) => {
    const fresh = seen.filter((id) => !decided.has(id)).slice(0, 7);
    await prisma.extractedFact.updateMany({ where: { id: { in: fresh } }, data: { reviewStatus: "REJECTED", reviewedAt: new Date(), reviewedByUserId: me.userId, reviewedVia: "SELF" } });
    fresh.forEach((id) => decided.add(id));
  });
  report("Deciding facts already shown, between pages, skips nothing unseen", JSON.stringify(live.ids) === JSON.stringify(expected), `${live.ids.length} seen, ${decided.size} decided meanwhile`);
  await prisma.extractedFact.updateMany({ where: { id: { in: [...decided] } }, data: { reviewStatus: "PENDING", reviewedAt: null, reviewedByUserId: null, reviewedVia: null } });

  // 4. Refusals and filters.
  report("A cursor that isn't one is refused", await factsPage(me.userId, undefined, { cursor: "not-a-cursor" }).then(() => false, (e) => (e as Error).constructor.name === "BadRequestError"));
  const only2 = await walk(me.userId, { processingId: r2.id });
  report("The processing filter holds, across pages", JSON.stringify(only2.ids) === JSON.stringify(order(rows.filter((r) => r.processingId === r2.id))));
  report("Another person's own list never includes these facts", !(await walk(other.userId)).ids.some((id) => id.startsWith(`fp-${tag}`)));
  report("…and they can't page them as a member without a proxy grant", await factsPage(other.userId, me.personId, {}).then(() => false, () => true));

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
