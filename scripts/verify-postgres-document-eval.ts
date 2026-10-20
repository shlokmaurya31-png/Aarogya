/**
 * Week 4a, step j — the evaluation set through the real pipeline
 * (docs/DOCUMENT_PIPELINE_DESIGN.md §10.2: gating and exactness).
 *
 * A cross-section of the 50 synthetic samples (every category, every
 * language, printed and handwritten) is uploaded by synthetic Persons and run
 * by the dispatcher on the mock providers; a simulated review confirms only
 * the facts the fixture says are right (handwritten ones field by field)
 * and rejects the rest. Then:
 *   - gating: nothing entered the record before review, and only confirmed
 *     facts did (target: no exceptions);
 *   - exactness: every exact field of every entry equals the printed source
 *     byte for byte (target 100%).
 * Field accuracy is scored without the database by npm test
 * (src/lib/documents/eval.test.ts) and `npm run eval:documents`.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-document-eval.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { uploadPersonDocument } from "../src/lib/person/documents";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { FIXTURES } from "../src/lib/documents/fixtures";
import { fixturePdf } from "../src/lib/documents/fixtures/build";
import { EXACT_FIELDS } from "../src/lib/documents/factSchemas";
import { confirmFact, confirmFactField, listOwnFacts, rejectFact } from "../src/lib/documents/review";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const tag = Date.now().toString(36);
let clock = Date.now();
async function drain() {
  for (let i = 0; i < 40; i++) {
    clock += 2 * 3_600_000;
    if ((await dispatchPendingDomainEvents({ now: new Date(clock), batchSize: 500, maxDurationMs: 60_000 })).claimed === 0) return;
  }
}
const canon = (v: unknown) => JSON.stringify(v, Object.keys((v ?? {}) as object).sort());

/** One sample of each category and language, printed and handwritten. */
const SELECTED = ["lab-en-cbc", "lab-bn-lft", "lab-ta-sugar", "rx-gu-1", "rx-hi-2", "rx-hw-en-2", "rx-hw-te-1", "rx-hw-mr-2", "dc-kn-2", "dc-hi-1", "img-ml-usg", "mixed-ta-rx"];

async function main() {
  registerAllConsumers();
  const fixtures = FIXTURES.filter((f) => SELECTED.includes(f.id));
  report(`The cross-section: ${fixtures.length} samples, ${new Set(fixtures.map((f) => f.language)).size} languages, every category`,
    fixtures.length === SELECTED.length && new Set(fixtures.map((f) => f.category)).size === 6 && new Set(fixtures.map((f) => f.language)).size === 9);
  let beforeReview = 0, entries = 0, exactEntries = 0, confirmedNonMeta = 0, fromRejected = 0, decided = 0;
  for (const [i, f] of fixtures.entries()) {
    const a = await registerPatientAccount({ fullName: `Eval ${tag} ${i}`, email: `doceval-${tag}-${i}@verify.aarogya`, passwordHash: "x", sex: "F", dob: new Date("1990-01-01") });
    if (a.status !== "LINKED_NEW") throw new Error("fixture person");
    const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: a.userId } })).personId;
    await prisma.person.update({ where: { id: personId }, data: { dataClassification: "SYNTHETIC", preferredLanguage: f.targetLanguage } });
    await uploadPersonDocument(a.userId, { bytes: await fixturePdf(f), contentType: "application/pdf", originalName: `${f.id}.pdf`, title: f.id, type: "REPORT" });
    await drain();
    beforeReview += await prisma.patientProvidedRecord.count({ where: { personId } });
    const expected = new Set(f.expected.map((e) => `${e.factType}|${canon(e.value)}`));
    for (const fact of await listOwnFacts(a.userId)) {
      const right = expected.has(`${fact.factType}|${canon(fact.value)}`) && fact.exactCopyCheck === "PASSED";
      if (!right) await rejectFact(a.userId, fact.id, { version: fact.version });
      else if (fact.handwritten) { let v = fact.version; for (const field of fact.fields) v = (await confirmFactField(a.userId, fact.id, field, { version: v })).version; }
      else await confirmFact(a.userId, fact.id, { version: fact.version });
      decided += 1;
    }
    await drain();
    const facts = await prisma.extractedFact.findMany({ where: { personId } });
    const records = await prisma.patientProvidedRecord.findMany({ where: { personId } });
    confirmedNonMeta += facts.filter((x) => x.reviewStatus === "CONFIRMED" && x.factType !== "DOCUMENT_META").length;
    entries += records.length;
    for (const r of records) {
      const fact = facts.find((x) => x.id === r.factId)!;
      if (fact.reviewStatus === "REJECTED") fromRejected += 1;
      const printed = f.expected.find((e) => e.factType === fact.factType && canon(e.value) === canon(r.value))?.sourceText ?? "";
      const v = r.value as Record<string, unknown>;
      if (EXACT_FIELDS[fact.factType].every((k) => v[k] === undefined || printed.split(String(v[k])).length > 1)) exactEntries += 1;
    }
  }
  report("Gating: nothing entered the record before review", beforeReview === 0, String(beforeReview));
  report("Gating: every entry comes from a confirmed fact, and every confirmed fact (but DOCUMENT_META) is an entry", fromRejected === 0 && entries === confirmedNonMeta && entries > 0, `${entries} entries, ${confirmedNonMeta} confirmed, ${decided} decided`);
  report("Exactness: every exact field of every entry equals the printed source, byte for byte (100%)", exactEntries === entries, `${exactEntries}/${entries}`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
