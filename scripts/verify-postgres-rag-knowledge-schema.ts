/**
 * RAG Phase 1, steps 1.3–1.7 — the new schema holds (docs/RAG_IMPLEMENTATION_PLAN.md
 * §3; ADR 0005 part B), on a fresh database. Every refusal has a positive
 * control beside it, so a check that can't fail fails.
 *
 *   1. Knowledge documents: the facility must be in the organisation; the
 *      approver is never the uploader; an approval names who and when; only an
 *      approved version is published; the effective window is ordered; the
 *      same bytes twice for one document are refused; a failed ingestion says
 *      why; the hash is sha-256 hex.
 *   2. The index: a KNOWLEDGE row has an organisation and access class and no
 *      patient, person or sharing category; a patient or person row has no
 *      access class; an IMPORTED row is a facility record's and staff-only; a
 *      KNOWLEDGE row is VERIFIED and staff-only. The embedding trigger copies
 *      the organisation and access class. English stems only for English.
 *   3. Isolation both ways, in SQL: a knowledge chunk containing the query's
 *      words is never a candidate for a patient's scope, and a patient's chunk
 *      never matches a knowledge filter. A PENDING chunk is never a candidate.
 *   4. The embedding cache: knowledge text only; a second call embeds nothing;
 *      it holds a hash and a vector, never text; a bad hash is refused.
 *   5. Attribution rows go with their interaction; pg_trgm is in public.
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { issueAiPermit } from "../src/lib/ai/record/permit";
import { knowledgePermit } from "../src/lib/ai/realData";
import { activeSpace, chunkEmbeddingText } from "../src/lib/rag/embed";
import { cachedKnowledgeEmbeddings, contentHash } from "../src/lib/rag/embedCache";
import { candidateSearch } from "../src/lib/rag/search";
import { hashEmbed } from "../src/lib/ai/embeddings/mock";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const refused = <T>(p: Promise<T>) => p.then(() => false, () => true);
const tag = Date.now().toString(36);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function main() {
  const pune = await prisma.facility.findUniqueOrThrow({ where: { id: "fac-amc-pune" }, select: { id: true, organizationId: true } });
  const otherOrg = await prisma.organization.create({ data: { name: `Knowledge other org ${tag}`, slug: `knowledge-other-${tag}` } }).catch(async () => prisma.organization.findFirstOrThrow({ where: { id: { not: pune.organizationId } } }));
  const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@amc-demo.aarogya" }, select: { id: true } });
  const approver = await prisma.user.findFirstOrThrow({ where: { email: "doctor1@amc-demo.aarogya" }, select: { id: true } });

  // ── 1. Knowledge documents ──
  const docData = { organizationId: pune.organizationId, type: "SOP" as const, accessClass: "CLINICAL" as const, title: `Sepsis bundle ${tag}`, ownerUserId: admin.id };
  report("Knowledge: a facility outside the organisation is refused", await refused(prisma.knowledgeDocument.create({ data: { ...docData, organizationId: otherOrg.id, facilityId: pune.id } })));
  const doc = await prisma.knowledgeDocument.create({ data: { ...docData, facilityId: pune.id } });
  report("Knowledge: control — the facility's own organisation is accepted", !!doc.id);
  const v = { documentId: doc.id, storageRef: `knowledge/${tag}/v1.pdf`, contentType: "application/pdf", byteSize: 1000, uploadedByUserId: admin.id };
  report("Knowledge: the approver can never be the uploader", await refused(prisma.knowledgeDocumentVersion.create({ data: { ...v, version: 1, sha256: sha("a"), approvalStatus: "APPROVED", approvedByUserId: admin.id, approvedAt: new Date() } })));
  report("Knowledge: an approval names its approver and time", await refused(prisma.knowledgeDocumentVersion.create({ data: { ...v, version: 1, sha256: sha("a"), approvalStatus: "APPROVED" } })));
  report("Knowledge: a DRAFT can't be published", await refused(prisma.knowledgeDocumentVersion.create({ data: { ...v, version: 1, sha256: sha("a"), publishedAt: new Date() } })));
  report("Knowledge: the effective window must be ordered", await refused(prisma.knowledgeDocumentVersion.create({ data: { ...v, version: 1, sha256: sha("a"), effectiveAt: new Date("2027-01-02"), expiresAt: new Date("2027-01-01") } })));
  report("Knowledge: the hash must be sha-256 hex", await refused(prisma.knowledgeDocumentVersion.create({ data: { ...v, version: 1, sha256: "not-a-hash" } })));
  report("Knowledge: a failed ingestion says why", await refused(prisma.knowledgeDocumentVersion.create({ data: { ...v, version: 1, sha256: sha("a"), ingestionStatus: "FAILED" } })));
  const v1 = await prisma.knowledgeDocumentVersion.create({ data: { ...v, version: 1, sha256: sha("a"), approvalStatus: "APPROVED", approvedByUserId: approver.id, approvedAt: new Date(), publishedAt: new Date() } });
  report("Knowledge: control — approved by someone else, published", !!v1.id);
  report("Knowledge: the same bytes twice for one document are refused", await refused(prisma.knowledgeDocumentVersion.create({ data: { ...v, version: 2, sha256: sha("a") } })));
  const v2 = await prisma.knowledgeDocumentVersion.create({ data: { ...v, version: 2, sha256: sha("b") } });
  report("Knowledge: control — new bytes are a new version", v2.version === 2);

  // ── 2. The index ──
  const space = await activeSpace();
  const patient = await prisma.patient.findFirstOrThrow({ where: { facilityId: pune.id }, orderBy: { createdAt: "asc" }, select: { id: true } });
  const person = await prisma.person.create({ data: { displayName: `Knowledge schema ${tag}` }, select: { id: true } });
  const base = { contentHash: "h", title: "t", recordedAt: new Date(), embeddingModel: space.embeddingModel, embeddingDim: space.dims };
  const knowledgeDoc = (over: Partial<Prisma.RagDocumentUncheckedCreateInput> = {}) => prisma.ragDocument.create({ data: {
    ownerType: "KNOWLEDGE", organizationId: pune.organizationId, facilityId: pune.id, sourceType: "KNOWLEDGE_DOCUMENT", sourceId: v1.id, sourceVersion: 1, origin: "VERIFIED", categories: [], audience: "STAFF_ONLY", accessClass: "CLINICAL", knowledgeVersionId: v1.id, ...base, ...over,
  } });
  report("Index: a KNOWLEDGE row with a patient is refused", await refused(knowledgeDoc({ patientId: patient.id, sourceId: `k1-${tag}` })));
  report("Index: a KNOWLEDGE row with a person is refused", await refused(knowledgeDoc({ personId: person.id, sourceId: `k2-${tag}` })));
  report("Index: a KNOWLEDGE row without an access class is refused", await refused(knowledgeDoc({ accessClass: null, sourceId: `k3-${tag}` })));
  report("Index: a KNOWLEDGE row with a sharing category is refused", await refused(knowledgeDoc({ categories: ["LABS"], sourceId: `k4-${tag}` })));
  report("Index: a KNOWLEDGE row that is patient-visible is refused", await refused(knowledgeDoc({ audience: "PATIENT_VISIBLE", sourceId: `k5-${tag}` })));
  report("Index: a KNOWLEDGE row that is patient-provided is refused", await refused(knowledgeDoc({ origin: "PATIENT_PROVIDED", sourceId: `k6-${tag}` })));
  const kDoc = await knowledgeDoc();
  report("Index: control — a well-formed KNOWLEDGE row is accepted", !!kDoc.id);
  const facilityDoc = (over: Partial<Prisma.RagDocumentUncheckedCreateInput>) => prisma.ragDocument.create({ data: {
    ownerType: "FACILITY_PATIENT", organizationId: pune.organizationId, facilityId: pune.id, patientId: patient.id, sourceType: "LEGACY_LAB_RESULT", sourceId: `legacy-${tag}`, sourceVersion: 1, origin: "IMPORTED", categories: ["LABS"], audience: "STAFF_ONLY", ...base, ...over,
  } });
  report("Index: a patient row with an access class is refused", await refused(facilityDoc({ accessClass: "CLINICAL", sourceId: `p1-${tag}` })));
  report("Index: an IMPORTED row visible to the patient is refused", await refused(facilityDoc({ audience: "PATIENT_VISIBLE", sourceId: `p2-${tag}` })));
  report("Index: an IMPORTED row owned by a Person is refused", await refused(prisma.ragDocument.create({ data: { ownerType: "PERSON", personId: person.id, sourceType: "LEGACY_LAB_RESULT", sourceId: `p3-${tag}`, sourceVersion: 1, origin: "IMPORTED", categories: ["LABS"], audience: "STAFF_ONLY", ...base } })));
  const importedDoc = await facilityDoc({});
  report("Index: control — an IMPORTED, staff-only facility row is accepted", !!importedDoc.id);

  // Chunks: one knowledge chunk ACTIVE and one PENDING, and a patient chunk, all sharing the canary words.
  const canary = `zebracanary${tag}`;
  const chunk = (documentId: string, over: Partial<Prisma.RagChunkUncheckedCreateInput>) => prisma.ragChunk.create({ data: {
    documentId, chunkNo: 0, origin: "VERIFIED", audience: "STAFF_ONLY", sourceType: "KNOWLEDGE_DOCUMENT", sourceId: v1.id, recordedAt: new Date(), context: "[Reference · Sepsis bundle]", text: `Sepsis bundle ${canary}: lactate within one hour.`, tokenCount: 12,
    ownerType: "KNOWLEDGE", organizationId: pune.organizationId, accessClass: "CLINICAL", categories: [], ...over,
  } });
  const kChunk = await chunk(kDoc.id, { pageNumber: 2, sectionPath: "Bundle / First hour" });
  const pendingDoc = await knowledgeDoc({ sourceId: `pending-${tag}`, status: "PENDING" });
  const pendingChunk = await chunk(pendingDoc.id, { sourceId: `pending-${tag}`, status: "PENDING" });
  const pChunk = await prisma.ragChunk.create({ data: {
    documentId: importedDoc.id, chunkNo: 0, origin: "IMPORTED", audience: "STAFF_ONLY", sourceType: "LEGACY_LAB_RESULT", sourceId: importedDoc.sourceId, recordedAt: new Date(), context: "[Imported lab result · Lactate · imported]", text: `Lactate 4.1 mmol/L ${canary}.`, tokenCount: 8,
    ownerType: "FACILITY_PATIENT", facilityId: pune.id, patientId: patient.id, categories: ["LABS"],
  } });
  for (const c of [kChunk, pendingChunk, pChunk]) {
    await prisma.$executeRaw`INSERT INTO "RagEmbedding" ("id", "chunkId", "embeddingModel", "embeddingVersion", "dims", "embedding") VALUES (${`ks-${c.id}`}, ${c.id}, ${space.embeddingModel}, ${space.embeddingVersion}, ${space.dims}, ${`[${hashEmbed(chunkEmbeddingText(c), space.dims).join(",")}]`}::halfvec)`;
  }
  const emb = await prisma.ragEmbedding.findFirstOrThrow({ where: { chunkId: kChunk.id } });
  report("Index: the embedding trigger copies the organisation and access class", emb.organizationId === pune.organizationId && emb.accessClass === "CLINICAL" && emb.ownerType === "KNOWLEDGE" && emb.patientId === null);
  const [kTsv] = await prisma.$queryRaw<{ en: boolean }[]>`SELECT "tsvEnglish" IS NOT NULL AS en FROM "RagChunk" WHERE "id" = ${kChunk.id}`;
  const hi = await prisma.ragChunk.create({ data: { documentId: kDoc.id, chunkNo: 1, origin: "VERIFIED", audience: "STAFF_ONLY", sourceType: "KNOWLEDGE_DOCUMENT", sourceId: v1.id, recordedAt: new Date(), context: "[Reference]", text: "सेप्सिस बंडल", tokenCount: 3, ownerType: "KNOWLEDGE", organizationId: pune.organizationId, accessClass: "CLINICAL", categories: [], language: "hi" } });
  const [hiTsv] = await prisma.$queryRaw<{ en: boolean }[]>`SELECT "tsvEnglish" IS NOT NULL AS en FROM "RagChunk" WHERE "id" = ${hi.id}`;
  report("Index: English stems only for an English chunk", kTsv.en && !hiTsv.en);

  // ── 3. Isolation, both ways ──
  const scope = { segments: [{ path: "TREATING", facility: { patientIds: [patient.id], facilityIds: [pune.id] }, categories: ["LABS" as const, "CLINICAL_NOTES" as const], sensitive: [], audiences: ["STAFF_ONLY" as const, "PATIENT_VISIBLE" as const], origins: ["VERIFIED" as const, "IMPORTED" as const] }] };
  const found = await candidateSearch({ scope, space: { model: space.embeddingModel, version: space.embeddingVersion }, queryVector: hashEmbed(`Sepsis bundle ${canary}`, space.dims), terms: ["sepsis", "bundle", canary] });
  const ids = new Set(found.map((f) => f.chunkId));
  report("Isolation: a patient's scope finds its own (imported) chunk — control", ids.has(pChunk.id));
  report("Isolation: a knowledge chunk is never a candidate in a patient's scope", !ids.has(kChunk.id) && !ids.has(pendingChunk.id));
  const knowledgeRows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT c."id" FROM "RagChunk" c WHERE c."ownerType" = 'KNOWLEDGE' AND c."status" = 'ACTIVE' AND c."organizationId" = ${pune.organizationId}
      AND c."accessClass" = ANY(${["CLINICAL"]}::"KnowledgeAccessClass"[]) AND c."text" ILIKE ${`%${canary}%`}`);
  report("Isolation: a knowledge filter finds the active knowledge chunk — control", knowledgeRows.some((r) => r.id === kChunk.id));
  report("Isolation: a knowledge filter never matches a patient chunk or a PENDING one", !knowledgeRows.some((r) => r.id === pChunk.id || r.id === pendingChunk.id));
  const otherOrgRows = await prisma.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT count(*) AS n FROM "RagEmbedding" e WHERE e."ownerType" = 'KNOWLEDGE' AND e."organizationId" = ${otherOrg.id} AND e."chunkId" = ${kChunk.id}`);
  report("Isolation: another organisation's filter never reaches it", Number(otherOrgRows[0].n) === 0);

  // ── 4. The embedding cache ──
  const kPermit = knowledgePermit(pune.organizationId);
  const texts = [`Sepsis bundle ${tag}`, `Lactate within one hour ${tag}`, `Sepsis bundle ${tag}`];
  const first = await cachedKnowledgeEmbeddings(space, texts, kPermit);
  const second = await cachedKnowledgeEmbeddings(space, texts, kPermit);
  report("Cache: identical text embedded once; a second call embeds nothing", first.embedded === 2 && second.embedded === 0 && second.hits === 2, `first ${first.embedded}, second ${second.embedded}/${second.hits}`);
  report("Cache: the cached vectors are the computed ones", JSON.stringify(second.vectors[0].map((x) => x.toFixed(2))) === JSON.stringify(first.vectors[0].map((x) => x.toFixed(2))));
  const rowJson = JSON.stringify(await prisma.$queryRaw`SELECT to_jsonb(c) - 'embedding' AS row, length("embedding"::text) > 0 AS has_vector FROM "AiEmbeddingCache" c WHERE "contentHash" = ${contentHash(texts[0])}`, (_k, v) => (typeof v === "bigint" ? String(v) : v));
  report("Cache: a row holds a hash and a vector, never the text", !rowJson.includes("Sepsis") && rowJson.includes(contentHash(texts[0])));
  report("Cache: a person's or patient's permit is refused", await refused(cachedKnowledgeEmbeddings(space, ["x"], issueAiPermit(`person:${person.id}`, false))));
  const external = { ...space, provider: "voyage", embeddingModel: "voyage-multilingual-2" };
  const extRes = await cachedKnowledgeEmbeddings(external, ["Sepsis"], knowledgePermit(pune.organizationId)).then(() => "embedded", (e: { code?: string }) => e.code ?? "error");
  report("Cache: an external provider is refused while the organisation's knowledge setting is off (default)", extRes === "REAL_DATA_REFUSED", extRes);
  report("Cache: a bad hash is refused by the table", await refused(prisma.$executeRaw`INSERT INTO "AiEmbeddingCache" ("id", "embeddingModel", "embeddingVersion", "contentHash", "dims", "embedding") VALUES (${`bad-${tag}`}, 'm', 1, 'nothex', 3, '[1,0,0]'::halfvec)`));

  // ── 5. Attribution, extensions ──
  const interaction = await prisma.aiInteraction.create({ data: { userId: approver.id, role: "DOCTOR", mode: "CHART_QA", language: "en", model: "mock", embeddingModel: space.embeddingModel, embeddingVersion: space.embeddingVersion, outcome: "ANSWERED", latencyMs: 1, metadataExpiresAt: new Date(Date.now() + 86_400_000),
    sources: { create: [{ rank: 1, cited: true, sourceKind: "CHUNK", sourceType: "LEGACY_LAB_RESULT", sourceId: importedDoc.sourceId, chunkId: pChunk.id, ragDocumentId: importedDoc.id, sourceVersion: 1, origin: "IMPORTED", recordedAt: new Date() }] } } });
  report("Attribution: a source row has no text column", !Object.keys(Prisma.AiInteractionSourceScalarFieldEnum).some((k) => /text|content|answer|question/i.test(k)));
  report("Attribution: an unknown source kind is refused", await refused(prisma.aiInteractionSource.create({ data: { interactionId: interaction.id, rank: 2, cited: false, sourceKind: "WEB", sourceType: "X", sourceId: "x", origin: "VERIFIED", recordedAt: new Date() } })));
  await prisma.aiInteraction.delete({ where: { id: interaction.id } });
  report("Attribution: source rows go with their interaction", (await prisma.aiInteractionSource.count({ where: { interactionId: interaction.id } })) === 0);
  const [ext] = await prisma.$queryRaw<{ schema: string }[]>`SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_trgm'`;
  report("pg_trgm is installed in public (by migration)", ext?.schema === "public", ext?.schema);

  // Leave nothing behind that a later gate could trip on.
  await prisma.ragDocument.deleteMany({ where: { id: { in: [kDoc.id, pendingDoc.id, importedDoc.id] } } });
  await prisma.aiEmbeddingCache.deleteMany({ where: { contentHash: { in: texts.map(contentHash) } } });

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
