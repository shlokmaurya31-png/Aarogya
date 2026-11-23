/**
 * RAG Phase 2 — the ingestion gate (docs/RAG_IMPLEMENTATION_PLAN.md §4.2,
 * §4.4), on a fresh database, mock embeddings, synthetic documents only.
 * Every refusal or absence has a positive control beside it.
 *
 *   1. One indexed document per version; chunks and embeddings PENDING; a
 *      replayed event creates nothing and calls no provider.
 *   2. The same bytes twice for one document: refused as a duplicate, nothing stored.
 *   3. The same bytes under a second document embed nothing new (the cache).
 *   4. A version that is not in force is never a candidate: PENDING,
 *      REJECTED, future-dated, expired (before and after the sweep),
 *      superseded and withdrawn, each a canary with a positive control.
 *   5. Publishing supersedes in one transaction: a reader polling during the
 *      publish sees exactly one ACTIVE version every time; a superseded
 *      version never outranks the current one.
 *   6. A provider outage retries (the outbox event goes to RETRY), and after
 *      the attempt limit ends FAILED with a closed code; an unreadable file
 *      ends FAILED; both can be re-run.
 *   7. The bulk lane never delays a live event, with a 1,000-chunk document queued.
 *   Also: the uploader can't approve (service and database); an
 *   identifier-bearing file is refused with nothing kept; Facility B never
 *   sees Facility A's SOP, by knowledge search or by a record retrieval
 *   (where citations come from); an instruction inside a document is text
 *   only; parsing fidelity on every format (numbers, units, medicine names);
 *   a 50-page PDF indexed within three runner ticks; the cache hit rate.
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { readdirSync } from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { runTick } from "../src/lib/runner/tick";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { emitDomainEvent } from "../src/lib/events/emit";
import { RetryableEventError } from "../src/lib/events/types";
import { setEmbeddingProviderForTest, embeddingProviderFor, EmbeddingUnavailableError, type EmbeddingProvider } from "../src/lib/ai/embeddings";
import { approveKnowledgeVersion, rejectKnowledgeVersion, retryKnowledgeIngestion, uploadKnowledge, withdrawKnowledgeVersion, type KnowledgeActor } from "../src/lib/knowledge/service";
import { ingestKnowledgeVersion, MAX_ATTEMPTS } from "../src/lib/knowledge/ingest";
import { publishKnowledgeVersion, sweepKnowledgeSchedule } from "../src/lib/knowledge/publish";
import { KnowledgeError } from "../src/lib/knowledge/errors";
import { searchKnowledge } from "../src/lib/rag/knowledgeSearch";
import { candidateSearch } from "../src/lib/rag/search";
import { activeSpace } from "../src/lib/rag/embed";
import { hashEmbed } from "../src/lib/ai/embeddings/mock";
import { getStorageAdapter } from "../src/lib/storage";
import { formatFixtures, makePdf, NOIDA, PROMPT_INJECTION, PUNE, sopPages, staffUser } from "./lib/knowledgeGate";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const tag = Date.now().toString(36);
const word = (s: string) => `${s}${tag}`.replace(/[^a-z0-9]/gi, "").toLowerCase();
const ALL = ["ALL_STAFF", "CLINICAL", "PHARMACY", "BILLING", "ADMIN"] as const;
const utf8 = (s: string) => Buffer.from(s, "utf8");

let providerCalls = 0;
let failProvider = false;
function countingProvider() {
  setEmbeddingProviderForTest((space) => {
    setEmbeddingProviderForTest(null);
    const inner = embeddingProviderFor(space);
    countingProvider();
    const p: EmbeddingProvider = {
      ...inner,
      async embed(texts, kind, permit) {
        providerCalls++;
        if (failProvider) throw new EmbeddingUnavailableError("PROVIDER_UNAVAILABLE");
        return inner.embed(texts, kind, permit);
      },
    };
    return p;
  });
}

async function drain() {
  for (let i = 0; i < 20; i++) if (!(await dispatchPendingDomainEvents({ batchSize: 500, maxDurationMs: 30_000 })).claimed) return;
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try { await p; return null; } catch (e) { return e instanceof KnowledgeError ? e.code : (e as Error).message; }
}

async function md(actor: KnowledgeActor, name: string, body: string, extra: Partial<Parameters<typeof uploadKnowledge>[1]> = {}) {
  return uploadKnowledge(actor, { title: `${name} ${tag}`, documentType: "SOP", accessClass: "CLINICAL", fileName: `${name}-${tag}.md`, declaredType: "text/markdown", bytes: utf8(body), ...extra });
}

/** Ingest every queued knowledge version (calls the consumer's work directly; the dispatcher path is checked in 6 and 7). */
async function ingestAll() {
  const queued = await prisma.knowledgeDocumentVersion.findMany({ where: { ingestionStatus: { in: ["RECEIVED", "PARSING", "EMBEDDING"] }, document: { title: { contains: tag } } }, select: { id: true } });
  for (const q of queued) await ingestKnowledgeVersion(q.id).catch((e) => { if (!(e instanceof RetryableEventError)) throw e; });
}

const scopeOf = (a: KnowledgeActor) => ({ organizationId: a.organizationId, facilityId: a.facilityId, accessClasses: [...ALL] });
const found = async (a: KnowledgeActor, q: string, now?: Date) => (await searchKnowledge(scopeOf(a), q, { now, limit: 20 }));
const has = async (a: KnowledgeActor, canary: string, now?: Date) => (await found(a, canary, now)).some((h) => h.text.toLowerCase().includes(canary));

async function main() {
  registerAllConsumers();
  countingProvider();
  const admin = await staffUser(`kg-admin-${tag}@verify.aarogya`, "HOSPITAL_ADMIN", PUNE, { orgAdmin: true });
  const superintendent = await staffUser(`kg-super-${tag}@verify.aarogya`, "MEDICAL_SUPERINTENDENT", PUNE);
  const quality = await staffUser(`kg-quality-${tag}@verify.aarogya`, "QUALITY_LEAD", PUNE);
  const noidaAdmin = await staffUser(`kg-noida-admin-${tag}@verify.aarogya`, "HOSPITAL_ADMIN", NOIDA);
  const noidaSuper = await staffUser(`kg-noida-super-${tag}@verify.aarogya`, "MEDICAL_SUPERINTENDENT", NOIDA);

  // Earlier gates' events are delivered first, so nothing else calls the provider while this gate counts.
  await drain();

  // ── 1. One indexed document per version; replay creates nothing ──
  const c1 = word("canaryone");
  const up1 = await md(admin, "Hand hygiene", `# Hand hygiene\n\nWash for 40 seconds. ${c1}.\n\n## Alcohol rub\n\nUse 3 mL of 70% rub.\n`);
  const outbox = await prisma.domainEventOutbox.findFirstOrThrow({ where: { eventType: "KnowledgeDocumentVersionUploaded", aggregateId: up1.documentId } });
  report("Upload: the ingestion event is on the bulk lane", outbox.bulk === true);
  report("Upload: the version waits SUBMITTED and RECEIVED", (await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: up1.versionId } })).ingestionStatus === "RECEIVED");
  report("Upload: nothing is in the index before ingestion", (await prisma.ragDocument.count({ where: { knowledgeVersionId: up1.versionId } })) === 0);
  const before = providerCalls;
  report("Ingest: indexed", (await ingestKnowledgeVersion(up1.versionId)) === "INDEXED");
  const v1 = await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: up1.versionId } });
  const rds = await prisma.ragDocument.findMany({ where: { knowledgeVersionId: up1.versionId } });
  const chunks1 = await prisma.ragChunk.findMany({ where: { documentId: { in: rds.map((r) => r.id) } } });
  const embs1 = await prisma.ragEmbedding.count({ where: { chunk: { documentId: { in: rds.map((r) => r.id) } } } });
  report("Ingest: one indexed document for the version", rds.length === 1 && rds[0].status === "PENDING" && rds[0].ownerType === "KNOWLEDGE");
  report("Ingest: chunks and embeddings written PENDING, with section paths", chunks1.length === v1.chunkCount && chunks1.every((c) => c.status === "PENDING" && c.organizationId === admin.organizationId && c.accessClass === "CLINICAL") && embs1 === chunks1.length && chunks1.some((c) => c.sectionPath === "Hand hygiene > Alcohol rub"));
  report("Ingest: the version is INDEXED with its counts", v1.ingestionStatus === "INDEXED" && v1.indexedAt !== null && (v1.cacheHitCount ?? 0) + (v1.embeddedCount ?? 0) === v1.chunkCount && providerCalls > before);
  report("Ingest: Parsed and Indexed events emitted", (await prisma.domainEventOutbox.count({ where: { aggregateId: up1.documentId, eventType: { in: ["KnowledgeDocumentVersionParsed", "KnowledgeDocumentVersionIndexed"] } } })) === 2);
  const calls = providerCalls;
  const cacheUse = await prisma.aiEmbeddingCache.aggregate({ _max: { lastUsedAt: true }, _count: true });
  report("Replay: a second delivery is nothing to do", (await ingestKnowledgeVersion(up1.versionId)) === "UNCHANGED");
  await prisma.$transaction((tx) => emitDomainEvent(tx, { type: "KnowledgeDocumentVersionUploaded", aggregateId: up1.documentId, organizationId: admin.organizationId, facilityId: PUNE, payload: { documentId: up1.documentId, versionId: up1.versionId, version: 1, format: "MARKDOWN", attempt: 2 } }));
  for (let i = 0; i < 5; i++) await dispatchPendingDomainEvents({ batchSize: 200, maxDurationMs: 20_000 });
  const cacheAfter = await prisma.aiEmbeddingCache.aggregate({ _max: { lastUsedAt: true }, _count: true });
  report("Replay: the replayed event creates nothing", (await prisma.ragDocument.count({ where: { knowledgeVersionId: up1.versionId } })) === 1 && (await prisma.ragChunk.count({ where: { documentId: rds[0].id } })) === chunks1.length);
  report("Replay: no provider call, and the cache wasn't even read", providerCalls === calls && cacheAfter._count === cacheUse._count && String(cacheAfter._max.lastUsedAt) === String(cacheUse._max.lastUsedAt));

  // ── 2. The same bytes twice for one document ──
  const storeDir = path.resolve(__dirname, "..", ".data", "object-store", "knowledge-documents");
  const files = () => { try { return readdirSync(storeDir, { recursive: true }).length; } catch { return 0; } };
  const nFiles = files();
  const body1 = `# Hand hygiene\n\nWash for 40 seconds. ${c1}.\n\n## Alcohol rub\n\nUse 3 mL of 70% rub.\n`;
  report("Duplicate: the same bytes again for the document are refused", (await codeOf(md(admin, "Hand hygiene", body1, { documentId: up1.documentId }))) === "DUPLICATE");
  report("Duplicate: no version and no stored file was added", (await prisma.knowledgeDocumentVersion.count({ where: { documentId: up1.documentId } })) === 1 && files() === nFiles);

  // ── 3. The same bytes under a second document embed nothing new ──
  const callsDup = providerCalls;
  const cacheRows = await prisma.aiEmbeddingCache.count();
  const dup = await md(admin, "Hand hygiene copy", body1, { title: `Hand hygiene (ICU copy) ${tag}` });
  await ingestKnowledgeVersion(dup.versionId);
  const vd = await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: dup.versionId } });
  report("Cache: identical text under a second document embeds nothing new", vd.embeddedCount === 0 && vd.cacheHitCount === vd.chunkCount && providerCalls === callsDup && (await prisma.aiEmbeddingCache.count()) === cacheRows, `${vd.cacheHitCount}/${vd.chunkCount} from the cache`);

  // ── Approval: the uploader can't approve; a second person can ──
  const uploaderAsApprover = { ...superintendent, userId: admin.userId };
  report("Approval: the uploader is refused, even holding the approve permission", (await codeOf(approveKnowledgeVersion(uploaderAsApprover, up1.versionId))) === "SELF_APPROVAL");
  report("Approval: the database refuses it too", await prisma.knowledgeDocumentVersion.update({ where: { id: up1.versionId }, data: { approvalStatus: "APPROVED", approvedByUserId: admin.userId, approvedAt: new Date() } }).then(() => false, () => true));
  report("Canary PENDING: an indexed, unapproved version is never a candidate", !(await has(admin, c1)));
  const ap1 = await approveKnowledgeVersion(superintendent, up1.versionId);
  report("Approval: a second person approves; in force now, published at once", ap1.published === true);
  report("Canary PENDING control: once published, it is found", await has(admin, c1));

  // ── 4. Canaries for every state that is not in force ──
  const rej = word("canaryrejected"), fut = word("canaryfuture"), exp = word("canaryexpired"), wd = word("canarywithdrawn");
  const uRej = await md(admin, "Rejected SOP", `# Rejected\n\n${rej} spill kit.\n`);
  const uFut = await md(admin, "Future SOP", `# Future\n\n${fut} triage.\n`);
  const uExp = await md(admin, "Expiring SOP", `# Expiring\n\n${exp} cold chain.\n`, { expiresAt: new Date(Date.now() + 60 * 60_000) });
  const uWd = await md(admin, "Withdrawn SOP", `# Withdrawn\n\n${wd} needle stick.\n`);
  await ingestAll();
  await rejectKnowledgeVersion(quality, uRej.versionId, "Out of date guidance");
  report("Canary REJECTED: never a candidate", !(await has(admin, rej)) && (await prisma.ragChunk.count({ where: { sourceId: uRej.documentId } })) === 0);
  const tomorrow = new Date(Date.now() + 24 * 3600_000);
  const apF = await approveKnowledgeVersion(quality, uFut.versionId, { effectiveAt: tomorrow });
  report("Canary FUTURE: approved with a future effective date, not published, not a candidate", apF.published === false && !(await has(admin, fut)));
  const swept = await sweepKnowledgeSchedule({ now: new Date(tomorrow.getTime() + 60_000) });
  report("Canary FUTURE control: the runner publishes it at its effective date; then found", swept.published >= 1 && (await has(admin, fut, new Date(tomorrow.getTime() + 120_000))));
  await approveKnowledgeVersion(superintendent, uExp.versionId);
  report("Canary EXPIRED control: in force before its expiry, found", await has(admin, exp));
  const after = new Date(Date.now() + 2 * 3600_000);
  report("Canary EXPIRED: past its expiry, not a candidate even before the sweep", !(await has(admin, exp, after)));
  await sweepKnowledgeSchedule({ now: after });
  const expDoc = await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: uExp.documentId } });
  report("Canary EXPIRED: the sweep takes it out of the index and the document has no current version", expDoc.currentVersionId === null && (await prisma.ragChunk.count({ where: { sourceId: uExp.documentId } })) === 0 && !(await has(admin, exp)));
  await approveKnowledgeVersion(superintendent, uWd.versionId);
  report("Canary WITHDRAWN control: published, found", await has(admin, wd));
  await withdrawKnowledgeVersion(admin, uWd.versionId, "Replaced by the national protocol");
  report("Canary WITHDRAWN: never a candidate after withdrawal", !(await has(admin, wd)) && (await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: uWd.documentId } })).currentVersionId === null);

  // ── 5. Supersede in one transaction; superseded never outranks ──
  const old = word("canarysuperseded"), shared = word("canaryshared");
  const s1 = await md(admin, "Insulin protocol", `# Insulin\n\n${shared} ${old} sliding scale 2 units.\n`);
  await ingestAll();
  await approveKnowledgeVersion(superintendent, s1.versionId);
  const s2 = await md(admin, "Insulin protocol", `# Insulin\n\n${shared} basal bolus 0.5 units/kg.\n`, { documentId: s1.documentId });
  await ingestAll();
  // A reader polls the document's ACTIVE versions while the approval publishes v2.
  let polling = true;
  const seen: number[] = [];
  const poll = (async () => {
    while (polling) {
      const n = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "RagDocument" WHERE "sourceType" = 'KNOWLEDGE_DOCUMENT' AND "sourceId" = ${s1.documentId} AND "status" = 'ACTIVE'`;
      seen.push(Number(n[0].n));
    }
  })();
  await approveKnowledgeVersion(quality, s2.versionId);
  await new Promise((r) => setTimeout(r, 50));
  polling = false;
  await poll;
  report("Supersede: a reader during the publish always sees exactly one ACTIVE version", seen.length > 0 && seen.every((n) => n === 1), `${seen.length} reads`);
  const vOld = await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: s1.versionId } });
  report("Supersede: v1 SUPERSEDED by v2, v2 current", vOld.supersededByVersionId === s2.versionId && (await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: s1.documentId } })).currentVersionId === s2.versionId);
  const hits = await found(admin, `${shared} ${old} insulin`);
  report("Supersede: the superseded version is never a candidate, so never outranks the current one", hits.some((h) => h.versionId === s2.versionId) && !hits.some((h) => h.versionId === s1.versionId));
  report("Supersede: an older version can't be published over a newer one", !(await prisma.$transaction((tx) => publishKnowledgeVersion(tx, s1.versionId, new Date()))));

  // ── Identifier-bearing upload: refused, nothing kept ──
  const docsBefore = await prisma.knowledgeDocumentVersion.count();
  const filesBefore = files();
  const auditBefore = await prisma.auditEvent.count({ where: { type: "knowledge.upload.refused" } });
  const ids = await codeOf(md(admin, "Discharge example", `# Example\n\nMr. Ramesh Kumar, 45 years, UHID-AMCP-7Q2XKD, phone 9876543210.\n`));
  const audit = await prisma.auditEvent.findFirst({ where: { type: "knowledge.upload.refused" }, orderBy: { createdAt: "desc" } });
  report("Identifiers: an upload naming a patient is refused", ids === "CONTAINS_IDENTIFIERS");
  report("Identifiers: nothing kept — no version, no stored file", (await prisma.knowledgeDocumentVersion.count()) === docsBefore && files() === filesBefore);
  report("Identifiers: the audit names the kinds, never a value", (await prisma.auditEvent.count({ where: { type: "knowledge.upload.refused" } })) === auditBefore + 1 && !/9876543210|Ramesh|7Q2XKD/.test(JSON.stringify(audit?.detail)));
  report("Identifiers: control — the same document without them is accepted", !!(await md(admin, "Discharge example", `# Example\n\nRecord the UHID before transfer. Call 108 in an emergency.\n`)).versionId);

  // ── Facility B never sees Facility A's SOP ──
  const fa = word("canarypuneonly"), org = word("canaryorgwide");
  const pa = await md(admin, "Pune only SOP", `# Pune\n\n${fa} oxygen cylinders.\n`);
  const ow = await md(admin, "Organisation SOP", `# All sites\n\n${org} fire drill.\n`, { scope: "ORGANIZATION" });
  await ingestAll();
  await approveKnowledgeVersion(superintendent, pa.versionId);
  await approveKnowledgeVersion(noidaSuper, ow.versionId);
  report("Isolation control: Pune finds its own SOP", await has(admin, fa));
  report("Isolation: Noida never finds Pune's SOP", !(await has(noidaAdmin, fa)) && !(await found(noidaAdmin, `${fa} oxygen`)).some((h) => h.knowledgeDocumentId === pa.documentId));
  report("Isolation control: an organisation-wide SOP is found at both", (await has(noidaAdmin, org)) && (await has(admin, org)));
  report("Isolation: Noida's approver can't approve Pune's version (not found)", /Not found/.test((await codeOf(approveKnowledgeVersion(noidaSuper, pa.versionId))) ?? ""));
  report("Isolation: Noida's administrator can't withdraw it (not found)", /Not found/.test((await codeOf(withdrawKnowledgeVersion(noidaAdmin, pa.versionId, "not ours"))) ?? ""));
  const space = await activeSpace();
  const noidaPatient = await prisma.patient.findFirstOrThrow({ where: { facilityId: NOIDA }, select: { id: true } });
  const recordScope = { segments: [{ path: "TREATING" as const, facility: { patientIds: [noidaPatient.id], facilityIds: [NOIDA] }, categories: ["LABS" as const, "CLINICAL_NOTES" as const, "PRESCRIPTIONS" as const, "UPLOADS" as const], sensitive: [], audiences: ["STAFF_ONLY" as const, "PATIENT_VISIBLE" as const], origins: ["VERIFIED" as const, "IMPORTED" as const] }] };
  const rec = await candidateSearch({ scope: recordScope, space: { model: space.embeddingModel, version: space.embeddingVersion }, queryVector: hashEmbed(`${fa} oxygen cylinders`, space.dims), terms: [fa, "oxygen", "cylinders"] });
  const recChunks = rec.length ? await prisma.ragChunk.findMany({ where: { id: { in: rec.map((r) => r.chunkId) } }, select: { ownerType: true } }) : [];
  report("Isolation: a record retrieval (the source of every citation) never returns a knowledge chunk", recChunks.every((c) => c.ownerType !== "KNOWLEDGE"));
  // Phase 3 added KNOWLEDGE_QA, whose answers cite knowledge documents; no other mode (a record answer) ever may.
  const citedKnowledge = await prisma.aiInteractionSource.count({ where: { OR: [{ knowledgeVersionId: { not: null } }, { sourceType: "KNOWLEDGE_DOCUMENT" }], interaction: { mode: { not: "KNOWLEDGE_QA" } } } });
  report("Isolation: no record-mode AI answer has ever cited a knowledge chunk (only KNOWLEDGE_QA cites them)", citedKnowledge === 0);

  // ── An instruction inside a document is text only ──
  const inj = word("canaryinjection");
  const ui = await md(admin, "Injected SOP", `# Spill response\n\n${PROMPT_INJECTION} ${inj}\n\nCover the spill with 1% hypochlorite for 10 minutes.\n`);
  const uh = await uploadKnowledge(admin, { title: `Injected HTML ${tag}`, documentType: "POLICY", accessClass: "ALL_STAFF", fileName: `inj-${tag}.html`, declaredType: "text/html", bytes: utf8(`<h1>Policy</h1><p>${inj} visitors</p><script>fetch("/api/hospital/knowledge/versions/x/approve",{method:"POST"})</script><img src=x onerror="alert(1)">`) });
  await ingestAll();
  const vi = await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: ui.versionId } });
  const injChunks = await prisma.ragChunk.findMany({ where: { sourceId: { in: [ui.documentId, uh.documentId] } } });
  report("Injection: the instruction is indexed as plain text, verbatim", injChunks.some((c) => c.text.includes("Ignore all previous instructions")));
  report("Injection: it changed nothing — still waiting for a person to approve, nothing published", vi.approvalStatus === "SUBMITTED" && vi.publishedAt === null && !(await has(admin, inj)));
  report("Injection: HTML script and attributes are dropped, never stored", injChunks.every((c) => !/fetch\(|onerror|<script/i.test(c.text)) && injChunks.some((c) => c.text.includes(`${inj} visitors`)));
  report("Injection: the citation context is the document's, not the document's words", injChunks.every((c) => c.context.startsWith("[Reference · Injected")));

  // ── Parsing fidelity on every format ──
  let kept = 0, wanted = 0;
  const lost: string[] = [];
  for (const f of formatFixtures(tag)) {
    const u = await uploadKnowledge(admin, { title: `Fidelity ${f.name}`, documentType: "CLINICAL_REFERENCE", accessClass: "CLINICAL", fileName: f.name, declaredType: f.type, bytes: utf8(f.text) });
    await ingestKnowledgeVersion(u.versionId);
    const text = (await prisma.ragChunk.findMany({ where: { sourceId: u.documentId }, select: { text: true } })).map((c) => c.text).join("\n");
    for (const k of f.keep) { wanted++; if (text.includes(k)) kept++; else lost.push(`${f.name}: ${k}`); }
    if (f.name.endsWith(".html")) report("Fidelity: HTML script text never reaches a chunk", !text.includes("Warfarin 99"));
  }
  const pdfPages = sopPages(6, tag);
  const pdfU = await uploadKnowledge(admin, { title: `Fidelity PDF ${tag}`, documentType: "SOP", accessClass: "CLINICAL", fileName: `fidelity-${tag}.pdf`, declaredType: "application/pdf", bytes: await makePdf(pdfPages) });
  await ingestKnowledgeVersion(pdfU.versionId);
  const pdfChunks = await prisma.ragChunk.findMany({ where: { sourceId: pdfU.documentId }, select: { text: true, pageNumber: true, sectionPath: true } });
  const pdfText = pdfChunks.map((c) => c.text).join("\n");
  for (const l of pdfPages.flat()) for (const k of l.match(/\d+(?:\.\d+)?\s?(?:mg|mL|g|minutes|hours)|Paracetamol|Ceftriaxone|Amoxicillin|Metformin/g) ?? []) { wanted++; if (pdfText.includes(k)) kept++; else lost.push(`pdf: ${k}`); }
  report("Fidelity: 100% of numbers, units and medicine names are in the chunks (six formats)", kept === wanted, `${kept}/${wanted}${lost.length ? `; lost ${lost.slice(0, 5).join(", ")}` : ""}`);
  report("Fidelity: PDF chunks carry their page and section; the running footer is gone", pdfChunks.every((c) => c.pageNumber !== null && c.sectionPath !== null) && new Set(pdfChunks.map((c) => c.pageNumber)).size === 6 && !/Synthetic SOP for testing|Page \d+ of/.test(pdfText));
  report("Fidelity: a table is one chunk with its header", pdfChunks.some((c) => c.text.startsWith("| Medicine | Dose | Route |") && c.text.includes("Metformin")));

  // ── 6. Provider outage: retries, then FAILED; unreadable: FAILED; both re-run ──
  const outage = await md(admin, "Outage SOP", `# Outage\n\n${word("canaryoutage")} generator test.\n`);
  failProvider = true;
  for (let i = 0; i < 3; i++) await dispatchPendingDomainEvents({ batchSize: 200, maxDurationMs: 20_000 });
  const ev = await prisma.domainEventOutbox.findFirstOrThrow({ where: { eventType: "KnowledgeDocumentVersionUploaded", aggregateId: outage.documentId } });
  const vo = await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: outage.versionId } });
  report("Outage: the ingestion event is retried by the dispatcher (RETRY), nothing indexed", ev.status === "RETRY" && vo.ingestionStatus !== "INDEXED" && (await prisma.ragDocument.count({ where: { knowledgeVersionId: outage.versionId } })) === 0, `${ev.status}, ${vo.ingestionStatus}`);
  let outcome = "";
  for (let i = vo.ingestionAttempts; i < MAX_ATTEMPTS; i++) outcome = await ingestKnowledgeVersion(outage.versionId).catch((e) => (e instanceof RetryableEventError ? "RETRY" : String(e)));
  const vo2 = await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: outage.versionId } });
  report("Outage: after the attempt limit, FAILED with a closed code; a partial version is never indexed", outcome === "FAILED" && vo2.ingestionStatus === "FAILED" && vo2.ingestionError === "PROVIDER_UNAVAILABLE" && (await prisma.ragChunk.count({ where: { sourceId: outage.documentId } })) === 0);
  report("Outage: IngestionFailed emitted", (await prisma.domainEventOutbox.count({ where: { aggregateId: outage.documentId, eventType: "KnowledgeDocumentIngestionFailed" } })) === 1);
  failProvider = false;
  await retryKnowledgeIngestion(admin, outage.versionId);
  report("Outage: re-run after the provider is back: INDEXED", (await ingestKnowledgeVersion(outage.versionId)) === "INDEXED");
  report("Re-run: only a FAILED version can be re-run", (await codeOf(retryKnowledgeIngestion(admin, outage.versionId))) === "NOT_FAILED");
  // An unreadable file (stored bytes that are not the PDF they claim to be).
  const broken = await md(admin, "Broken PDF", `# Broken\n\nplaceholder ${tag}\n`);
  const stored = await getStorageAdapter().put({ bucket: "knowledge-documents", bytes: Buffer.from("%PDF-1.7\nnot really a pdf"), contentType: "application/pdf", originalName: `broken-${tag}.pdf`, scope: admin.organizationId });
  await prisma.knowledgeDocumentVersion.update({ where: { id: broken.versionId }, data: { storageRef: stored.storageRef, format: "PDF" } });
  report("Unreadable: ends FAILED with a closed code", (await ingestKnowledgeVersion(broken.versionId)) === "FAILED" && (await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: broken.versionId } })).ingestionError === "UNREADABLE");
  report("Unreadable: can be re-run (and fails again, with the same code)", !!(await retryKnowledgeIngestion(admin, broken.versionId)) && (await ingestKnowledgeVersion(broken.versionId)) === "FAILED");
  report("Unreadable: a failed version can't be approved", (await codeOf(approveKnowledgeVersion(superintendent, broken.versionId))) === "NOT_INDEXED");

  // ── 7. The bulk lane never delays a live event; throughput ──
  await drain();
  const big = Array.from({ length: 1000 }, (_, i) => `## Item ${i + 1}\n\nCheck ${word("bulk")} unit ${i + 1}: ${i + 1} mL.`).join("\n\n");
  const bulk = await md(admin, "Bulk register", `# Register\n\n${big}\n`);
  const live = await prisma.$transaction((tx) => emitDomainEvent(tx, { type: "ChartPreferenceChanged", aggregateId: admin.userId, organizationId: admin.organizationId, facilityId: PUNE, payload: { userId: admin.userId, showImportedResults: false } }));
  // One bounded call: its first round takes the live lane (the upload's Created event and this one); the deadline then ends it.
  await dispatchPendingDomainEvents({ batchSize: 10, maxDurationMs: 1 });
  const liveRow = await prisma.domainEventOutbox.findFirstOrThrow({ where: { eventId: live.eventId } });
  const bulkRow = await prisma.domainEventOutbox.findFirstOrThrow({ where: { eventType: "KnowledgeDocumentVersionUploaded", aggregateId: bulk.documentId } });
  report("Bulk lane: a live event emitted after a 1,000-chunk upload is delivered first", liveRow.status === "PROCESSED" && bulkRow.status === "PENDING", `${liveRow.status} / ${bulkRow.status}`);
  let t0 = Date.now();
  for (let i = 0; i < 3 && (await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: bulk.versionId } })).ingestionStatus !== "INDEXED"; i++) await runTick({ budgetMs: 120_000 });
  const vb = await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: bulk.versionId } });
  report("Bulk lane: the 1,000-chunk document is indexed", vb.ingestionStatus === "INDEXED" && (vb.chunkCount ?? 0) >= 1000, `${vb.chunkCount} chunks in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const fifty = await uploadKnowledge(admin, { title: `Fifty pages ${tag}`, documentType: "SOP", accessClass: "CLINICAL", fileName: `fifty-${tag}.pdf`, declaredType: "application/pdf", bytes: await makePdf(sopPages(50, `${tag}-50`)) });
  t0 = Date.now();
  let ticks = 0;
  while (ticks < 3 && (await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: fifty.versionId } })).ingestionStatus !== "INDEXED") { await runTick({ budgetMs: 120_000 }); ticks++; }
  const secs = (Date.now() - t0) / 1000;
  const v50 = await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: fifty.versionId } });
  report("Throughput: a 50-page PDF (text layer, mock embeddings) is indexed within three runner ticks", v50.ingestionStatus === "INDEXED" && v50.pageCount === 50, `${ticks} tick(s), ${secs.toFixed(1)} s, ${v50.chunkCount} chunks, ${((v50.chunkCount ?? 0) / secs).toFixed(0)} chunks/s`);
  const again = await uploadKnowledge(admin, { title: `Fifty pages (second site) ${tag}`, documentType: "SOP", accessClass: "CLINICAL", fileName: `fifty-copy-${tag}.pdf`, declaredType: "application/pdf", bytes: await makePdf(sopPages(50, `${tag}-50`)) });
  await ingestKnowledgeVersion(again.versionId);
  const va = await prisma.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: again.versionId } });
  const totals = await prisma.knowledgeDocumentVersion.aggregate({ where: { document: { title: { contains: tag } }, ingestionStatus: "INDEXED" }, _sum: { chunkCount: true, cacheHitCount: true, embeddedCount: true } });
  report("Cache: the same PDF under a second document is all cache hits", va.embeddedCount === 0 && va.cacheHitCount === va.chunkCount, `${va.cacheHitCount}/${va.chunkCount}`);
  const rate = (totals._sum.cacheHitCount ?? 0) / Math.max(1, totals._sum.chunkCount ?? 0);
  console.log(`METRIC knowledge-ingest: 50-page PDF ${secs.toFixed(1)} s (${ticks} tick(s)), ${v50.chunkCount} chunks; 1,000-chunk document ${vb.chunkCount} chunks; cache hit rate over this gate's ${totals._sum.chunkCount} chunks ${(rate * 100).toFixed(1)}% (${totals._sum.cacheHitCount} hits, ${totals._sum.embeddedCount} embedded)`);

  setEmbeddingProviderForTest(null);
  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  setEmbeddingProviderForTest(null);
  await prisma.$disconnect();
  process.exit(1);
});
