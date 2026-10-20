/**
 * Week 4b, RAG step 4 — the embeddings adapter and the re-embed job
 * (docs/RAG_DESIGN.md §3.2a, §5.8, decision 8):
 *   - a re-embed to a mock model of ANOTHER dimension (384) reaches 100%
 *     coverage in resumable, idempotent batches; an owner the AI may not use
 *     is removed from the index rather than left to block it;
 *   - the switch is refused below 100% (and when a new chunk arrives
 *     unembedded), then retires the old space in the same transaction,
 *     announced and audited;
 *   - the switch changes rankings;
 *   - no step changes the schema (the column set and the vector column are
 *     the same before and after; the new dimension is just rows);
 *   - a retired space's embeddings go only after the grace period.
 * Ends with a fresh 1024-dimension mock space active again (version 2), so
 * later gates see the default dimension.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-rag-reembed.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { aiAssistancePermit } from "../src/lib/ai/realData";
import { embeddingProviderFor } from "../src/lib/ai/embeddings";
import { activeSpace, chunkEmbeddingText, computeEmbeddings, writeEmbeddings } from "../src/lib/rag/embed";
import { activateEmbeddingSpace, embeddingCoverage, purgeRetiredEmbeddings, reembedBatch, startReembed } from "../src/lib/rag/reembed";
import { candidateSearch } from "../src/lib/rag/search";
import { ALL_CATEGORIES, type RetrievalScope } from "../src/lib/rag/scope";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const refused = <T>(p: Promise<T>) => p.then(() => false, () => true);
const tag = Date.now().toString(36);
const TEXTS = [
  "Hemoglobin 11.2 g/dL (12.0 - 15.5), low.", "Creatinine 1.42 mg/dL (0.70 - 1.30), high.", "Sodium 138 mEq/L, within range.", "Potassium 4.6 mEq/L, within range.",
  "Fasting blood sugar 142 mg/dL, high.", "HbA1c 7.8 %, high.", "TSH 6.8 µIU/mL, high.", "Platelet count 245 x10^3/µL.", "Chest X-ray: right lower zone consolidation.",
  "Started amoxicillin 500 mg three times a day.", "Allergy: penicillin, rash.", "Blood pressure 150/94 mmHg.", "Wound clean and dry, dressing changed.", "Plan: repeat labs tomorrow.",
  "Referred to cardiology for chest pain.", "Discharged home in stable condition.", "Fever settled, tolerating oral diet.", "Pain controlled on paracetamol.",
];

async function columns() {
  return JSON.stringify(await prisma.$queryRaw<{ t: string; c: string; ty: string }[]>`SELECT table_name AS t, column_name AS c, udt_name AS ty FROM information_schema.columns WHERE table_name IN ('RagDocument', 'RagChunk', 'RagEmbedding', 'RagEmbeddingSpace') ORDER BY 1, 2`);
}

async function main() {
  const a = await registerPatientAccount({ fullName: `Reembed ${tag}`, email: `rag-reembed-${tag}@verify.aarogya`, passwordHash: "x", sex: "M", dob: new Date("1980-01-01") });
  if (a.status !== "LINKED_NEW") throw new Error("fixture");
  const link = await prisma.personPatientLink.findFirstOrThrow({ where: { person: { accounts: { some: { userId: a.userId } } }, status: "ACTIVE" }, include: { patient: { select: { facilityId: true, facility: { select: { organizationId: true } } } } } });
  const owner = { facilityId: link.patient.facilityId, patientId: link.patientId };
  const gate = await aiAssistancePermit(owner);
  if (!gate.allowed) throw new Error(`gate refused: ${gate.reason}`);
  report("The AI gate allows a synthetic facility's record (no real data, no consent needed)", gate.real === false);

  const space0 = await activeSpace();
  const addChunks = async (texts: string[], start: number) => {
    const ids: string[] = [];
    for (const [i, text] of texts.entries()) {
      const n = start + i;
      const doc = await prisma.ragDocument.create({ data: { ownerType: "FACILITY_PATIENT", organizationId: link.patient.facility.organizationId, ...owner, sourceType: "CLINICAL_NOTE", sourceId: `reembed-${tag}-${n}`, sourceVersion: 1, origin: "VERIFIED", contentHash: `h${n}`, categories: ["CLINICAL_NOTES"], audience: "PATIENT_VISIBLE", title: "Note", recordedAt: new Date(Date.now() - n * 3_600_000), embeddingModel: space0.embeddingModel, embeddingDim: space0.dims } });
      const c = await prisma.ragChunk.create({ data: { documentId: doc.id, chunkNo: 0, ownerType: "FACILITY_PATIENT", ...owner, categories: ["CLINICAL_NOTES"], origin: "VERIFIED", audience: "PATIENT_VISIBLE", sourceType: "CLINICAL_NOTE", sourceId: doc.sourceId, recordedAt: doc.recordedAt, context: `[Progress note · 2026-10-${String(1 + (n % 28)).padStart(2, "0")} · verified]`, text, tokenCount: 12 } });
      ids.push(c.id);
    }
    return ids;
  };
  const embedIn = async (space: typeof space0, ids: string[]) => {
    const chunks = await prisma.ragChunk.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
    const vecs = await computeEmbeddings(space, chunks.map(chunkEmbeddingText), gate.permit);
    await writeEmbeddings(prisma, space, chunks.map((c, i) => ({ chunkId: c.id, vector: vecs[i], ownerType: c.ownerType, facilityId: c.facilityId, patientId: c.patientId, personId: c.personId })));
  };
  const first = await addChunks([...TEXTS, ...TEXTS.map((t) => `Earlier: ${t}`)], 0);
  await embedIn(space0, first);
  report("36 chunks indexed and embedded in the active space (mock, 1024)", (await prisma.ragEmbedding.count({ where: { chunkId: { in: first }, embeddingModel: space0.embeddingModel } })) === 36 && space0.dims === 1024);

  // A Person the AI may not use (REAL, the switch off) whose rows somehow sit in the index.
  const realP = await prisma.person.create({ data: { displayName: `Real ${tag}` } });
  const realDoc = await prisma.ragDocument.create({ data: { ownerType: "PERSON", personId: realP.id, sourceType: "PATIENT_PROVIDED_RECORD", sourceId: `reembed-real-${tag}`, sourceVersion: 1, origin: "PATIENT_PROVIDED", contentHash: "r", categories: ["UPLOADS"], audience: "PATIENT_VISIBLE", title: "x", recordedAt: new Date(), embeddingModel: space0.embeddingModel, embeddingDim: 1024 } });
  await prisma.ragChunk.create({ data: { documentId: realDoc.id, chunkNo: 0, ownerType: "PERSON", personId: realP.id, categories: ["UPLOADS"], origin: "PATIENT_PROVIDED", audience: "PATIENT_VISIBLE", sourceType: "PATIENT_PROVIDED_RECORD", sourceId: realDoc.sourceId, recordedAt: new Date(), context: "[x]", text: "real data", tokenCount: 2 } });
  const before = await columns();
  const space = await startReembed({ embeddingModel: "mock-hash-384", embeddingVersion: 1, provider: "mock", dims: 384 });
  report("A re-embed to another dimension starts a BUILDING space, announced (RagEmbeddingSpaceChanged, platform)", space.status === "BUILDING"
    && (await prisma.domainEventOutbox.count({ where: { aggregateId: space.id, eventType: "RagEmbeddingSpaceChanged", organizationId: null, facilityId: null } })) === 1);
  report("Starting it again is the same space; another dimension under the same name is refused",
    (await startReembed({ embeddingModel: "mock-hash-384", embeddingVersion: 1, provider: "mock", dims: 384 })).id === space.id
      && await refused(startReembed({ embeddingModel: "mock-hash-384", embeddingVersion: 1, provider: "mock", dims: 512 })));
  report("A provider that can't embed now is refused before anything is written (Voyage without a key; India-hosted deferred)",
    await refused(startReembed({ embeddingModel: "voyage-multilingual-2", embeddingVersion: 1, provider: "voyage", dims: 1024 }))
      && await refused(startReembed({ embeddingModel: "ih-1", embeddingVersion: 1, provider: "india-hosted", dims: 768 }))
      && (await prisma.ragEmbeddingSpace.count({ where: { embeddingModel: { in: ["voyage-multilingual-2", "ih-1"] } } })) === 0);
  report("Switching below 100% coverage is refused", await refused(activateEmbeddingSpace({ spaceId: space.id, byUserId: a.userId })));

  // Three small batches (resumable: each picks up where the last stopped), then to the end
  // (other gates' chunks may share this database: coverage is of every ACTIVE chunk).
  const small: number[] = [];
  for (let i = 0; i < 3; i++) small.push((await reembedBatch({ spaceId: space.id, batchSize: 10 })).embedded);
  const mid = await embeddingCoverage(space.id);
  let removedTotal = 0;
  for (let i = 0; i < 1000; i++) {
    const r = await reembedBatch({ spaceId: space.id, batchSize: 1000 });
    removedTotal += r.removed;
    if (r.remaining === 0) break;
  }
  const cov = await embeddingCoverage(space.id);
  report("Resumable batches reach 100% coverage of every ACTIVE chunk", cov.ratio === 1 && small.every((n) => n <= 10) && mid.embedded >= 27 && mid.ratio < 1, `first batches ${small.join(",")}; ${cov.embedded}/${cov.activeChunks}; removed ${removedTotal}`);
  report("Our 36 chunks are all in the new space", (await prisma.ragEmbedding.count({ where: { chunkId: { in: first }, embeddingModel: "mock-hash-384" } })) === 36);
  report("An owner the AI may not use (a REAL Person, switch off) is removed from the index, not left to block coverage", (await prisma.ragDocument.count({ where: { id: realDoc.id } })) === 0);
  report("Another batch does nothing (idempotent on chunk, model, version)", (await reembedBatch({ spaceId: space.id })).embedded === 0);
  report("The new vectors have 384 dimensions, beside the 1024-dimension ones", (await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "RagEmbedding" WHERE "embeddingModel" = 'mock-hash-384' AND vector_dims("embedding") = 384 AND "dims" = 384`)[0].n >= BigInt(36));

  // Rankings in the two spaces.
  const scope: RetrievalScope = { segments: [{ path: "TREATING", facility: { patientIds: [owner.patientId], facilityIds: [owner.facilityId] }, categories: ALL_CATEGORIES, sensitive: [], audiences: ["STAFF_ONLY", "PATIENT_VISIBLE"], origins: ["VERIFIED"] }] };
  const rank = async (sp: { embeddingModel: string; embeddingVersion: number; provider: string; dims: number }, q: string) => {
    const [v] = await embeddingProviderFor(sp).embed([q], "query", gate.permit);
    return (await candidateSearch({ scope, space: { model: sp.embeddingModel, version: sp.embeddingVersion }, queryVector: v, terms: [] })).filter((c) => c.vectorRank !== null).sort((x, y) => x.vectorRank! - y.vectorRank!).map((c) => c.chunkId).slice(0, 10).join();
  };
  const qs = ["kidney creatinine high", "blood sugar control", "chest infection on x-ray", "allergy to penicillin"];
  let differs = 0;
  for (const q of qs) if ((await rank(space0, q)) !== (await rank(space, q))) differs += 1;
  report("The switch changes rankings (top 10 differ between the spaces)", differs >= 1, `${differs} of ${qs.length} queries`);

  // A chunk arriving unembedded blocks the switch until a batch covers it.
  const late = await addChunks(["Late note: ambulating with support."], 100);
  report("A new chunk without an embedding in the space blocks the switch", await refused(activateEmbeddingSpace({ spaceId: space.id, byUserId: a.userId })));
  await embedIn(space0, late);
  await reembedBatch({ spaceId: space.id });
  const active = await activateEmbeddingSpace({ spaceId: space.id, byUserId: a.userId });
  const old = await prisma.ragEmbeddingSpace.findUniqueOrThrow({ where: { id: space0.id } });
  report("At 100% the switch makes it ACTIVE and retires the old space in one transaction", active.status === "ACTIVE" && old.status === "RETIRED" && !!old.retiredAt && (await activeSpace()).id === space.id && (await prisma.ragEmbeddingSpace.count({ where: { status: "ACTIVE" } })) === 1);
  const evs = await prisma.domainEventOutbox.findMany({ where: { eventType: "RagEmbeddingSpaceChanged", aggregateId: { in: [space.id, space0.id] } } });
  report("…announced (ACTIVE and RETIRED) and audited", evs.some((e) => (e.payload as { status: string }).status === "ACTIVE") && evs.some((e) => (e.payload as { status: string }).status === "RETIRED")
    && (await prisma.auditEvent.count({ where: { type: "ai.embedding_space.activated" } })) >= 1);
  report("No schema change at any step (same columns and vector type before and after)", (await columns()) === before);

  const kept = await purgeRetiredEmbeddings({ graceDays: 7 });
  report("Within the grace period the retired space's embeddings stay", kept.deleted === 0 && (await prisma.ragEmbedding.count({ where: { embeddingModel: space0.embeddingModel, embeddingVersion: space0.embeddingVersion } })) > 0);
  const gone = await purgeRetiredEmbeddings({ graceDays: 7, now: new Date(Date.now() + 8 * 86_400_000) });
  report("After it, they are deleted (and only they)", gone.deleted > 0 && (await prisma.ragEmbedding.count({ where: { embeddingModel: space0.embeddingModel, embeddingVersion: space0.embeddingVersion } })) === 0
    && (await prisma.ragEmbedding.count({ where: { embeddingModel: "mock-hash-384" } })) > 0);

  // Back to the default dimension for later gates: the same model under a new version.
  const back = await startReembed({ embeddingModel: "mock-hash-1024", embeddingVersion: 2, provider: "mock", dims: 1024 });
  while ((await reembedBatch({ spaceId: back.id, batchSize: 1000 })).remaining > 0) { /* converge */ }
  await activateEmbeddingSpace({ spaceId: back.id, byUserId: a.userId });
  report("A new version of the same model is just another space (re-embedded and switched to)", (await activeSpace()).embeddingVersion === 2 && (await activeSpace()).dims === 1024);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
