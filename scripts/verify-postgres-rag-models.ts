/**
 * Week 4b, RAG step 3 — the AI index and AI interaction models
 * (docs/RAG_DESIGN.md §3, §4.3), on a fresh database:
 *   - owners: a facility row needs its facility and record, a Person row has
 *     no facility; patient-provided sources belong to a Person; at least one
 *     category; a withdrawn document says why;
 *   - one document per source version; chunks and embeddings go with it;
 *     an embedding's filter columns are always its chunk's (a trigger);
 *   - the vector has the dimension it says; any dimension is allowed (no
 *     fixed column), so a new model needs no migration; vectors are half
 *     precision and stay on the heap row (the latency budget needs it);
 *   - full-text search covers the text and any translation;
 *   - exactly one active embedding space, the offline one to start;
 *   - retained text is complete or absent, and kept at most 90 days; a
 *     reviewer read names a ticket;
 *   - the reviewer roles hold only the review permissions; staff modes are
 *     for doctors and nurses.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-rag-models.ts
 */
import { Prisma, Role } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { roleHasPermission } from "../src/lib/auth/permissions";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const refused = <T>(p: Promise<T>) => p.then(() => false, () => true);
const tag = Date.now().toString(36);

async function main() {
  const patient = await prisma.patient.findFirstOrThrow({ where: { facilityId: "fac-amc-pune" }, select: { id: true, facilityId: true, facility: { select: { organizationId: true } } } });
  const person = await prisma.person.findFirstOrThrow({ select: { id: true } });
  const base = { sourceVersion: 1, contentHash: "h", audience: "STAFF_ONLY" as const, title: "t", recordedAt: new Date(), embeddingModel: "mock-hash-1024", embeddingDim: 1024 };
  const fac = { ownerType: "FACILITY_PATIENT" as const, organizationId: patient.facility.organizationId, facilityId: patient.facilityId, patientId: patient.id, origin: "VERIFIED" as const, categories: ["LABS" as const] };
  let n = 0;
  const src = () => `gate-${tag}-${++n}`;

  report("A facility document without its facility or record is refused",
    await refused(prisma.ragDocument.create({ data: { ...base, ...fac, facilityId: null, sourceType: "LAB_RESULT", sourceId: src() } }))
      && await refused(prisma.ragDocument.create({ data: { ...base, ...fac, patientId: null, sourceType: "LAB_RESULT", sourceId: src() } })));
  report("A Person document with a facility is refused",
    await refused(prisma.ragDocument.create({ data: { ...base, ownerType: "PERSON", personId: person.id, facilityId: patient.facilityId, origin: "PATIENT_PROVIDED", categories: ["UPLOADS"], sourceType: "PATIENT_PROVIDED_RECORD", sourceId: src() } })));
  report("A patient-provided source owned by a facility is refused",
    await refused(prisma.ragDocument.create({ data: { ...base, ...fac, origin: "PATIENT_PROVIDED", sourceType: "PATIENT_PROVIDED_RECORD", sourceId: src() } })));
  report("A document with no category is refused", await refused(prisma.ragDocument.create({ data: { ...base, ...fac, categories: [], sourceType: "LAB_RESULT", sourceId: src() } })));
  report("A withdrawn document must say when and why", await refused(prisma.ragDocument.create({ data: { ...base, ...fac, status: "WITHDRAWN", sourceType: "LAB_RESULT", sourceId: src() } })));

  const sid = src();
  const doc = await prisma.ragDocument.create({ data: { ...base, ...fac, sourceType: "LAB_RESULT", sourceId: sid } });
  report("One document per source version", await refused(prisma.ragDocument.create({ data: { ...base, ...fac, sourceType: "LAB_RESULT", sourceId: sid } })));
  const v2 = await prisma.ragDocument.create({ data: { ...base, ...fac, sourceType: "LAB_RESULT", sourceId: sid, sourceVersion: 2 } });
  report("…and a new version of the same source is its own document", v2.id !== doc.id);
  const chunk = await prisma.ragChunk.create({ data: { documentId: doc.id, chunkNo: 0, ownerType: "FACILITY_PATIENT", facilityId: patient.facilityId, patientId: patient.id, categories: ["LABS"], origin: "VERIFIED", audience: "STAFF_ONLY", sourceType: "LAB_RESULT", sourceId: sid, recordedAt: new Date(), context: "[Lab result · CBC · 2026-10-14 · verified]", text: "Hemoglobin 11.2 g/dL (12.0 - 15.5), low.", translatedText: "हीमोग्लोबिन 11.2 g/dL", translationLanguage: "hi", tokenCount: 12 } });
  report("A chunk's owner is checked like its document's",
    await refused(prisma.ragChunk.create({ data: { documentId: doc.id, chunkNo: 1, ownerType: "FACILITY_PATIENT", personId: person.id, categories: ["LABS"], origin: "VERIFIED", audience: "STAFF_ONLY", sourceType: "LAB_RESULT", sourceId: sid, recordedAt: new Date(), context: "x", text: "x", tokenCount: 1 } })));
  const hits = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "RagChunk" WHERE "id" = ${chunk.id} AND "tsv" @@ to_tsquery('simple', 'hemoglobin') AND "tsv" @@ to_tsquery('simple', 'हीमोग्लोबिन') AND "tsv" @@ to_tsquery('simple', 'cbc')`;
  report("Full-text search (generated, GIN) covers the context line, the text and the translation", Number(hits[0].n) === 1);

  const emb = (id: string, dims: number, v: string) => prisma.$executeRaw`INSERT INTO "RagEmbedding" ("id", "chunkId", "embeddingModel", "embeddingVersion", "dims", "embedding", "ownerType", "facilityId", "patientId") VALUES (${id}, ${chunk.id}, ${`m-${dims}`}, 1, ${dims}, ${v}::halfvec, 'FACILITY_PATIENT', ${patient.facilityId}, ${patient.id})`;
  report("A vector whose dimension differs from its declared one is refused", await refused(emb(`e-${tag}-1`, 4, "[1,2,3]")));
  report("Any dimension is stored without a schema change (3 and 1024 side by side)",
    (await emb(`e-${tag}-2`, 3, "[1,2,3]")) === 1 && (await emb(`e-${tag}-3`, 1024, `[${Array.from({ length: 1024 }, (_, i) => (i % 7) / 7).join(",")}]`)) === 1);
  report("One embedding per chunk, model and version", await refused(emb(`e-${tag}-4`, 3, "[3,2,1]")));
  // A writer claiming other filter values is overruled by the chunk's own (trigger).
  await prisma.$executeRaw`INSERT INTO "RagEmbedding" ("id", "chunkId", "embeddingModel", "embeddingVersion", "dims", "embedding", "ownerType", "personId", "categories", "audience", "origin", "recordedAt", "sourceId") VALUES (${`e-${tag}-5`}, ${chunk.id}, 'm-lie', 1, 3, '[1,1,1]'::halfvec, 'PERSON', ${person.id}, ARRAY['UPLOADS']::"RagCategory"[], 'PATIENT_VISIBLE', 'PATIENT_PROVIDED', now(), 'elsewhere')`;
  const copied = await prisma.ragEmbedding.findFirstOrThrow({ where: { chunkId: chunk.id, embeddingModel: "m-lie" } });
  report("An embedding's filter columns are always its chunk's (a trigger copies them, whatever the writer sent)",
    copied.ownerType === "FACILITY_PATIENT" && copied.personId === null && copied.patientId === patient.id && copied.categories.join() === "LABS" && copied.audience === "STAFF_ONLY" && copied.origin === "VERIFIED" && copied.sourceId === sid);
  await prisma.ragChunk.update({ where: { id: chunk.id }, data: { personId: person.id } });
  report("…and follow the chunk when its Person is set", (await prisma.ragEmbedding.findMany({ where: { chunkId: chunk.id } })).every((e) => e.personId === person.id));
  await prisma.ragDocument.delete({ where: { id: doc.id } });
  report("Deleting a document deletes its chunks and their embeddings (a hard delete)",
    (await prisma.ragChunk.count({ where: { documentId: doc.id } })) === 0 && (await prisma.ragEmbedding.count({ where: { chunkId: chunk.id } })) === 0);

  const spaces = await prisma.ragEmbeddingSpace.findMany({ where: { status: "ACTIVE" } });
  report("Exactly one active embedding space: the offline mock (1024 dimensions) to start", spaces.length === 1 && spaces[0].provider === "mock" && spaces[0].dims === 1024);
  report("A second active space is refused", await refused(prisma.ragEmbeddingSpace.create({ data: { embeddingModel: `x-${tag}`, embeddingVersion: 1, provider: "mock", dims: 8, status: "ACTIVE" } })));

  const meta = { userId: "gate", role: "DOCTOR", mode: "CHART_QA", language: "en", model: "mock", embeddingModel: "mock-hash-1024", embeddingVersion: 1, outcome: "ANSWERED" as const, latencyMs: 5, metadataExpiresAt: new Date(Date.now() + 365 * 86_400_000) };
  report("Retained text without its key version, scope and expiry is refused", await refused(prisma.aiInteraction.create({ data: { ...meta, questionCiphertext: "c" } })));
  report("Retained text past 90 days is refused",
    await refused(prisma.aiInteraction.create({ data: { ...meta, questionCiphertext: "c", answerCiphertext: "c", keyVersion: 1, textScope: "STAFF_SAFETY", textExpiresAt: new Date(Date.now() + 91 * 86_400_000) } })));
  const kept = await prisma.aiInteraction.create({ data: { ...meta, questionCiphertext: "c", answerCiphertext: "c", keyVersion: 1, textScope: "STAFF_SAFETY", textExpiresAt: new Date(Date.now() + 90 * 86_400_000 - 1000) } });
  report("Metadata only, or complete text within 90 days, is kept", !!kept.id && !!(await prisma.aiInteraction.create({ data: meta })).id);
  report("A reviewer read without a ticket is refused", await refused(prisma.aiTextReadLog.create({ data: { interactionId: kept.id, readerUserId: "r", readerRole: "SAFETY_OFFICER", reasonCode: "QUALITY_REVIEW", ticketRef: " " } })));

  report("The reviewer roles exist and hold only the review permissions",
    [Role.CLINICAL_ADVISOR, Role.SAFETY_OFFICER].every((r) => roleHasPermission(r, "ai:interaction:text:read") && roleHasPermission(r, "ai:interaction:review") && !roleHasPermission(r, "patient:read") && !roleHasPermission(r, "clinical:chart:read") && !roleHasPermission(r, "ai:record:ask")));
  report("No other role can decrypt retained text", Object.values(Role).filter((r) => roleHasPermission(r, "ai:interaction:text:read")).sort().join() === "CLINICAL_ADVISOR,SAFETY_OFFICER");
  report("Staff AI modes are for doctors and nurses", Object.values(Role).filter((r) => roleHasPermission(r, "ai:record:ask")).sort().join() === "DOCTOR,NURSE");
  const col = await prisma.$queryRaw<{ t: string }[]>(Prisma.sql`SELECT format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a WHERE a.attrelid = '"RagEmbedding"'::regclass AND a.attname = 'embedding'`);
  report("The embedding column is an untyped halfvec (no fixed dimension)", col[0]?.t === "halfvec", col[0]?.t);
  const storage = await prisma.$queryRaw<{ s: string; opts: string[] | null }[]>(Prisma.sql`SELECT a.attstorage AS s, c.reloptions AS opts FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attrelid = '"RagEmbedding"'::regclass AND a.attname = 'embedding'`);
  report("Vectors stay on the heap row (storage MAIN, toast_tuple_target 8160)", storage[0]?.s === "m" && !!storage[0]?.opts?.includes("toast_tuple_target=8160"), JSON.stringify(storage[0]));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
