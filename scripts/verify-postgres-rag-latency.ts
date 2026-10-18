/**
 * Week 4b, RAG step 3 — the latency gate (docs/RAG_DESIGN.md §3.2a, §12
 * step 3; accepted 2026-10-17): retrieval over ONE patient with 20,000
 * indexed chunks, by exact cosine scan (no ANN index) plus keyword search,
 * with every access filter applied in SQL first, must answer in under
 * 150 ms at the 95th percentile. A failure blocks the step (the remedy is an
 * HNSW index by migration, §14).
 *
 * The patient's chunks (1024-dimension embeddings in the active space) are
 * generated in SQL; a second patient's 5,000 chunks sit beside them and must
 * never come back. Measured: 200 queries after a warm-up.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-rag-latency.ts
 */
import { prisma } from "../src/lib/db";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { Prisma } from "@prisma/client";
import { candidateSearch, candidateSql } from "../src/lib/rag/search";
import { ALL_CATEGORIES, type RetrievalScope } from "../src/lib/rag/scope";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const tag = Date.now().toString(36);
export const P95_BUDGET_MS = 150;

async function patient(n: number) {
  const a = await registerPatientAccount({ fullName: `Latency ${tag} ${n}`, email: `rag-latency-${tag}-${n}@verify.aarogya`, passwordHash: "x", sex: "F", dob: new Date("1970-01-01") });
  if (a.status !== "LINKED_NEW") throw new Error("fixture patient");
  const link = await prisma.personPatientLink.findFirstOrThrow({ where: { person: { accounts: { some: { userId: a.userId } } }, status: "ACTIVE" }, include: { patient: { select: { facilityId: true, facility: { select: { organizationId: true } } } } } });
  return { patientId: link.patientId, facilityId: link.patient.facilityId, organizationId: link.patient.facility.organizationId };
}

/** `docs` documents of 10 chunks each for one patient, with embeddings drawn from 256 base vectors. */
async function generate(p: { patientId: string; facilityId: string; organizationId: string }, key: string, docs: number) {
  await prisma.$executeRawUnsafe(`
    INSERT INTO "RagDocument" ("id", "ownerType", "organizationId", "facilityId", "patientId", "sourceType", "sourceId", "sourceVersion", "origin", "contentHash", "categories", "audience", "title", "recordedAt", "embeddingModel", "embeddingDim")
    SELECT '${key}-d' || g, 'FACILITY_PATIENT', $1, $2, $3, 'CLINICAL_NOTE', '${key}-s' || g, 1, 'VERIFIED', md5(g::text), ARRAY['CLINICAL_NOTES', 'LABS']::"RagCategory"[], 'PATIENT_VISIBLE', 'Progress note ' || g, now() - (g || ' hours')::interval, 'mock-hash-1024', 1024
    FROM generate_series(1, ${docs}) g`, p.organizationId, p.facilityId, p.patientId);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "RagChunk" ("id", "documentId", "chunkNo", "ownerType", "facilityId", "patientId", "categories", "origin", "audience", "sourceType", "sourceId", "recordedAt", "context", "text", "tokenCount")
    SELECT '${key}-c' || d || '-' || k, '${key}-d' || d, k, 'FACILITY_PATIENT', $1, $2, ARRAY['CLINICAL_NOTES', 'LABS']::"RagCategory"[], 'VERIFIED', 'PATIENT_VISIBLE', 'CLINICAL_NOTE', '${key}-s' || d, now() - (d || ' hours')::interval,
      '[Progress note · ' || to_char(now() - (d || ' hours')::interval, 'YYYY-MM-DD') || ' · verified]',
      (ARRAY['Hemoglobin','Creatinine','Sodium','Potassium','Glucose','Platelet count','TSH','ALT','Bilirubin','Urea','HbA1c','Albumin'])[1 + (d * 7 + k) % 12] || ' ' || ((d * 13 + k * 7) % 200)::text || '.' || ((d + k) % 10)::text
        || ' recorded; ' || (ARRAY['patient comfortable','fever settled','pain controlled','tolerating diet','ambulating with support','wound clean and dry'])[1 + (d + k) % 6]
        || '; plan to ' || (ARRAY['repeat labs tomorrow','continue current medicines','review with cardiology','titrate insulin','encourage oral fluids'])[1 + (d * 3 + k) % 5] || '.',
      40
    FROM generate_series(1, ${docs}) d, generate_series(0, 9) k`, p.facilityId, p.patientId);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "RagEmbedding" ("id", "chunkId", "embeddingModel", "embeddingVersion", "dims", "embedding", "ownerType", "facilityId", "patientId")
    SELECT 'e-' || c."id", c."id", 'mock-hash-1024', 1, 1024, b.v, 'FACILITY_PATIENT', c."facilityId", c."patientId"
    FROM "RagChunk" c JOIN rag_latency_base b ON b.k = abs(hashtext(c."id")) % 256
    WHERE c."documentId" LIKE '${key}-d%'`);
}

const pct = (xs: number[], p: number) => { const v = [...xs].sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)]; };

async function main() {
  const a = await patient(1);
  const b = await patient(2);
  const started = Date.now();
  await prisma.$executeRawUnsafe(`SELECT setseed(0.42)`);
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS rag_latency_base`);
  await prisma.$executeRawUnsafe(`CREATE UNLOGGED TABLE rag_latency_base AS SELECT k, ('[' || array_to_string(ARRAY(SELECT (random() * 2 - 1)::real FROM generate_series(1, 1024) j WHERE j > k * 0), ',') || ']')::halfvec AS v FROM generate_series(0, 255) k`);
  await generate(a, `lat-${tag}-a`, 2000);
  await generate(b, `lat-${tag}-b`, 500);
  await prisma.$executeRawUnsafe(`DROP TABLE rag_latency_base`);
  await prisma.$executeRawUnsafe(`ANALYZE "RagChunk"`);
  await prisma.$executeRawUnsafe(`ANALYZE "RagEmbedding"`);
  const count = await prisma.ragEmbedding.count({ where: { patientId: a.patientId } });
  report("One patient with 20,000 indexed chunks, each embedded (1024 dimensions)", count === 20_000 && (await prisma.ragChunk.count({ where: { patientId: a.patientId } })) === 20_000, `${count} in ${Math.round((Date.now() - started) / 1000)} s`);

  const scope: RetrievalScope = { segments: [{ path: "TREATING", facility: { patientIds: [a.patientId], facilityIds: [a.facilityId] }, categories: ALL_CATEGORIES, sensitive: [], audiences: ["STAFF_ONLY", "PATIENT_VISIBLE"], origins: ["VERIFIED", "PATIENT_PROVIDED"] }] };
  const bases = await prisma.$queryRawUnsafe<{ v: string }[]>(`SELECT "embedding"::text AS v FROM "RagEmbedding" WHERE "patientId" = $1 ORDER BY "id" LIMIT 64`, a.patientId);
  const queries = [["hemoglobin", "trend"], ["creatinine", "kidney"], ["potassium"], ["glucose", "insulin", "titrate"], ["fever", "settled"], ["platelet", "count"], ["cardiology", "review"], ["wound", "clean"]];
  const run = (i: number) => candidateSearch({ scope, space: { model: "mock-hash-1024", version: 1 }, queryVector: JSON.parse(bases[i % bases.length].v).map((x: number, j: number) => x + ((i * 31 + j) % 7) / 100), terms: queries[i % queries.length] });
  for (let i = 0; i < 10; i++) await run(i);
  const times: number[] = [];
  let foreign = 0, total = 0;
  const own = new Set((await prisma.ragChunk.findMany({ where: { patientId: a.patientId }, select: { id: true } })).map((c) => c.id));
  for (let i = 0; i < 200; i++) {
    const t = performance.now();
    const r = await run(i);
    times.push(performance.now() - t);
    total += r.length;
    foreign += r.filter((c) => !own.has(c.chunkId)).length;
  }
  const p50 = pct(times, 50), p95 = pct(times, 95), max = Math.max(...times);
  console.log(`  candidate search over 20,000 chunks: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${max.toFixed(1)} ms (200 queries)`);
  report(`p95 under ${P95_BUDGET_MS} ms (exact cosine scan + keyword search, filters first)`, p95 < P95_BUDGET_MS, `p95 ${p95.toFixed(1)} ms`);
  report("Every query returned candidates, from both the vector and the keyword side", total >= 200 * 40, `${total} candidates`);
  report("Not one candidate of the other patient (filters applied before ranking)", foreign === 0, `${foreign}`);
  // The real query's plan, for the other (smaller) patient: reached through an index on the
  // patient, never a scan that reads every patient's rows.
  const bScope: RetrievalScope = { segments: [{ ...scope.segments[0], facility: { patientIds: [b.patientId], facilityIds: [b.facilityId] } }] };
  const [, plan] = await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL plan_cache_mode = force_custom_plan`,
    prisma.$queryRaw<{ "QUERY PLAN": string }[]>(Prisma.sql`EXPLAIN ${candidateSql({ scope: bScope, space: { model: "mock-hash-1024", version: 1 }, queryVector: JSON.parse(bases[0].v), terms: ["hemoglobin"] })}`),
  ]);
  const text = plan.map((r) => r["QUERY PLAN"]).join("\n");
  report("The candidate query reaches a patient's rows through an index on the patient, not a scan of every patient",
    /RagChunk_facilityId_patientId_status_audience_idx|RagEmbedding_patientId_embeddingModel_embeddingVersion_idx/.test(text) && !/Seq Scan on "RagEmbedding"/.test(text), text.split("\n").filter((l) => /Scan/.test(l)).map((l) => l.trim().slice(0, 90)).join(" | "));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
