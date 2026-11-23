# RAG implementation plan: phases 1–8

- **Status:** Accepted (Phase 0, 2026-11-17; the twelve questions of §13 were decided the same day; §13.3 on 2026-11-18; §13.4 on 2026-11-23). Each phase starts only after the one before it is merged.
- **Architecture:** [`RAG_ARCHITECTURE.md`](RAG_ARCHITECTURE.md). **Audit:** [`RAG_AUDIT.md`](RAG_AUDIT.md). **Threats:** [`RAG_THREAT_MODEL.md`](RAG_THREAT_MODEL.md). **Decisions:** [`adr/0005`](adr/0005-rag-embeddings-providers-and-tables.md).

## Contents

1. Rules for every phase
2. Phase overview
3. Phase 1: foundations
4. Phase 2: knowledge ingestion
5. Phase 3: retrieval intelligence
6. Phase 4: token economy
7. Phase 5: gateway and generation
8. Phase 6: integration into the product
9. Phase 7: security hardening
10. Phase 8: evaluation and production readiness
11. The evaluation set and how thresholds are set
12. Definition of done, mapped to phases
13. Decisions before Phase 1 (2026-11-17), Phase 2 (2026-11-18) and Phase 3 (2026-11-23)

---

## 1. Rules for every phase

**Branches and merging**

- One branch per phase, `rag/phase-N`, from an up-to-date `main`. Pushed after every commit. `main` changes only through a merged pull request.
- Each step in a phase is its own commit, and the checks stay green after each.

**Checks, all of them, before a phase's pull request is ready**

`npm test`, `npm run lint -- --max-warnings=0`, `npm run build`, `npm run verify:all`, `npm run verify:isolated`, `npm run e2e`, `npm run perf:gate`, `npm run perf:mobile`.

`perf:mobile` arrived with PR #16 (merged 2026-11-17).

**Data and providers**

- Synthetic data only. `AI_REAL_DATA_ENABLED` stays off.
- Everything is built and gated on the deterministic mocks. A real-provider evaluation runs only when its key works; otherwise the report says **pending**, with the reason.
- The gates reset only `aarogya_verify` on localhost, under consent given for the task. Never the development database, staging or Supabase.

**Migrations**

- Additive only. No column or table that holds data is dropped or rewritten in these phases.
- A migration **refuses rather than guesses**: where existing rows could make a new constraint ambiguous, it stops with a message naming the rows.
- An enum value is added in its own migration, ahead of anything that uses it.
- Extensions are created by migrations, in `public` (ADR 0002).
- The drift check and a fresh-database apply pass after every migration.

**Standing rules**

- No assertion is weakened to make a check pass. A threshold changes only upward, or with a written reason in the pull request.
- Every state change emits a catalogued event in the same transaction, or carries a justified exemption (the CI emit rule).
- No secret or hash in an API response or a log. No full Aadhaar number stored anywhere.
- Scholar code never imports from the record or knowledge retrieval paths.

**At the end of every phase,** the pull request reports: what was built, files changed, migrations, checks run and their results, performance and token numbers where they apply, remaining risks, and the next phase.

## 2. Phase overview

| Phase | Delivers | Migrations | Depends on |
|---|---|---|---|
| 1 | Guards, schema, provider policy, the Indic benchmark | 5 | PR #16 merged (done) |
| 2 | Knowledge documents: upload, parse, chunk, embed, approve, version | 1 | Phase 1; the two approver roles (§13, open) |
| 3 | Intent router, structured readers, knowledge retrieval, Indic keyword search, imported label | 1 | Phase 2 |
| 4 | Token budgets, deterministic compression, embedding cache, usage accounting, the client's compact context | 0 | Phase 3 |
| 5 | The gateway complete: tiers, provider routing, `/api/chat` behind it, operational mode | 0 | Phase 4 |
| 6 | The screens, in eleven languages | 0 | Phase 5 |
| 7 | Every threat in the threat model has a gate | 0 | Phase 6 |
| 8 | Full evaluation, cost benchmark, runbooks, real-provider runs | 0 | Phase 7; working keys for the real runs |

The specification's order is kept, with two changes:

- **Guards move to the front.** Closing `/api/chat` to real data and adding the per-provider policy are the first steps of Phase 1, because they are safety guards on existing code.
- **Security is not left to Phase 7.** Each phase ships the leak canaries for what it adds. Phase 7 is the audit that every threat has a gate, plus the adversarial suites.

## 3. Phase 1: foundations

**Goal:** the schema, the guards and the measurements that every later phase needs. No new user-visible feature.

### 3.1 Steps

| # | Step | Gate |
|---|---|---|
| 1.1 | **`/api/chat` refuses REAL data.** A facility or person that is not `SYNTHETIC` gets the record-free assistant. | `verify-postgres-ai-assistant` extended: a REAL facility's chart never reaches the provider (the mock echoes its context, so a canary would surface). |
| 1.2 | **Per-provider data policy.** `AI_PHI_ALLOWED_<PROVIDER>`, default off, checked where each provider checks its permit. Voyage's hard-coded refusal becomes this flag. | `verify-postgres-ai-switch` extended: with the global switch on and consent granted, a real permit is still refused by every provider whose flag is off. Unit tests per provider. |
| 1.3 | **Enum values:** `RagOwnerType.KNOWLEDGE`, `RagOrigin.IMPORTED`, `RagSourceType.KNOWLEDGE_DOCUMENT` and `LEGACY_LAB_RESULT`, `RagDocumentStatus.PENDING`. | Migration applies on a fresh database; drift check. |
| 1.4 | **`pg_trgm`** created in `public`. `staging:check` reports it. | Fresh apply; `staging:check` unit test. |
| 1.5 | **Knowledge tables:** `KnowledgeDocument`, `KnowledgeDocumentVersion`. | `verify-postgres-rag-models` extended: constraints (one current version; approver is not the uploader; effective before expiry); tenancy sweep; facility-consistency gate. |
| 1.6 | **Index extensions:** organisation, access class, page, section path and the English text-search column on `RagChunk`; the copies on `RagEmbedding`; the owner CHECKs and the copy trigger extended for `KNOWLEDGE`; trigram index. | Constraint tests: a `KNOWLEDGE` row with a patient or person is refused; a patient row with an access class is refused. **Latency gate unchanged: p95 under 150 ms** at 20,000 chunks. **Leak gate unchanged: zero.** |
| 1.7 | **Accounting:** new columns on `AiInteraction`; `AiInteractionSource`; `AiEmbeddingCache`. Written from the existing path with what is known today. | `verify-postgres-ai-ask` extended: every answered request has its source rows; no row holds text. |
| 1.8 | **Retrieval metrics in the scorer:** recall@k, precision@k, MRR, nDCG@10, alongside the existing two measures. The baseline is recorded. | `verify-postgres-rag-eval`: the existing ≥ 90% on both measures, unchanged. The new metrics are reported and become floors (§11). |
| 1.9 | **The Indic retrieval benchmark** (ADR 0005): a synthetic set across eleven languages, with same-script, inflected, transliterated and cross-script cases; a harness that runs any `EmbeddingProvider` over it. | Runs in CI on the mock. Real providers: **pending** until a key works. |

### 3.2 Migrations

1. `rag_enum_values`: the five enum values.
2. `enable_pg_trgm`.
3. `knowledge_documents`: the two tables, their CHECKs and indexes.
4. `rag_index_knowledge`: columns, CHECKs, trigger, indexes on the three index tables.
5. `ai_interaction_accounting`: columns, `AiInteractionSource`, `AiEmbeddingCache`.

Each refuses if it finds rows it cannot classify. With today's data none should exist; the check is there for staging.

### 3.3 Thresholds

| Measure | Threshold |
|---|---|
| Existing evaluation, mocks | ≥ 90% correct with valid citations; ≥ 90% expected source retrieved (today 30/30 on both) |
| Leak gate | 0 leaks; every canary has a positive control |
| Retrieval latency | p95 < 150 ms, 20,000-chunk patient |
| Every screen and API | p95 ≤ 300 ms (`perf:gate`) |
| New retrieval metrics | Recorded as the baseline; no threshold yet |
| Indic benchmark on the mock | Recorded; cross-script cases are expected to fail and are reported as such |

### 3.4 Not in this phase

No ingestion, no new mode, no screen. No embedding model is adopted.

### 3.5 As built (2026-11-17)

| Step | Built | Gate |
|---|---|---|
| 1.1 | `/api/chat` goes through `src/lib/rag/assistant.ts`. Staff naming a patient get the record gateway (`askAi`, CHART_QA). Everything else is **record-free**: the assistant is given no record at all, and passes rate limits, the real-data switch, the person's AI consent (the same 403s), the patient safety rules, identifier masking, an assistant permit, the provider flag and a metadata-only log. | `verify-postgres-ai-assistant` (19 checks); `providerRoutes.test.ts` walks every route's imports: a provider is reachable only through a listed gateway that makes its checks |
| 1.2 | `AI_PHI_ALLOWED_ANTHROPIC`, `AI_PHI_ALLOWED_VOYAGE` (default off), checked inside every real provider beside its permit. Document permits now carry `real`. | `dataPolicy.test.ts`; the assistant gate |
| 1.3–1.6 | Five migrations, as §3.2. Knowledge rows in the existing index with `KNOWLEDGE`; `IMPORTED` origin (staff only, labelled, never verified); `PENDING` status. | `verify-postgres-rag-knowledge-schema` (39 checks, each refusal with a control); drift check |
| 1.7 | `AiInteractionSource` written for every answer (no text); accounting columns filled; `AiEmbeddingCache` behind `cachedKnowledgeEmbeddings` (knowledge text only). | `verify-postgres-ai-ask` (+6 checks) |
| 1.8 | Recall, Precision, MRR, nDCG in the RAG eval. **Baseline: Recall@8 0.80, Precision@8 0.22, MRR 0.64, nDCG@10 0.68** over 22 answered questions: below Phase 3's targets (0.90, 0.70), which Phase 3 must close. | `verify-postgres-rag-eval` records it |
| 1.9 | `npm run eval:rag:indic` with optional local-model vectors (`scripts/indic-embed.py`). Results: [`RAG_INDIC_BENCHMARK.md`](RAG_INDIC_BENCHMARK.md). | `verify-postgres-rag-indic` holds the offline floors |

**Found and fixed on the way:**
- **Indic query words were broken** before they reached Postgres (vowel signs are combining marks and were dropped): same-script keyword Recall@5 0.18 → 1.00.
- **The tenancy sweep depended on gate order** (PR #18; included here): a false positive, no leak.
- The build's type check ran out of Node's default heap on some CI runs: the CI build step gets 4 GB.

**Decisions taken while building** (each the more conservative option):
- The portal assistant is **record-free for everyone**, not only behind consent. A patient asks about their record through Explain, the timeline and pre-visit questions, which cite. A free-form patient mode over the record stays dropped (RAG_DESIGN §14).
- Its general replies are logged as `mode ASSISTANT`, metadata only; **no text is kept**, for staff or patients.
- A login with no Person can't have consented: refused, as for real data.
- `knowledge:manage` and `knowledge:approve` are **not created in Phase 1**; they come with the routes in Phase 2 (step 2.2). The `Role` enum has no medical superintendent or quality lead (§13.2).
- Knowledge rows are `VERIFIED` origin (an approved document) and labelled `reference` by their owner type; they carry no sharing category, by a CHECK.
- An imported result's renderer exists; nothing indexes imported results until Phase 3 (step 3.6).
- The mock embedder's tokeniser is left as it is: changing it would change stored mock vectors (a re-embed).
- The new RAG gates run in name order with the other unlisted gates, as the existing RAG gates do.

## 4. Phase 2: knowledge ingestion

**Goal:** an approved, versioned document becomes searchable, and nothing else does.

### 4.1 Steps

| # | Step | Gate |
|---|---|---|
| 2.1 | **Events:** `KnowledgeDocumentCreated`, `KnowledgeDocumentVersionUploaded`, `…Parsed`, `…Indexed`, `…IngestionFailed`, `…Approved`, `…Rejected`, `…Published`, `…Superseded`, `…Withdrawn`, `…Expired`. Catalogue and its document regenerated. | The emit-coverage test; `verify-postgres-consumer-registry`. |
| 2.2 | **Permissions and routes:** `knowledge:manage` (default: hospital administrator), `knowledge:approve` (default: medical superintendent, quality lead); upload, status, approve, withdraw. Two people to publish. | `verify-postgres-knowledge-access` (new): each route by role; the uploader cannot approve; another facility's document is 404. |
| 2.3 | **Parsers:** PDF text, plain text, Markdown, HTML, CSV, JSON. DOCX is deferred (§13 decision 7) and refused with a message asking for a PDF export. Image-only pages through the 4a OCR provider with a knowledge permit. | Golden-file tests per format. A file whose type and bytes disagree is refused. |
| 2.4 | **Sections, normalisation, noise removal.** Tables kept whole with their header. Page and section path on every chunk. | Golden tests; a property test that no number or unit is lost in normalisation. |
| 2.5 | **Identifier refusal** (§13 decision 8). The identifier detector gains UHID- and Aadhaar-shaped patterns. A file containing anything that looks like a patient identifier (an ABHA-, UHID-, Aadhaar- or Indian-mobile-shaped number) is refused (`CONTAINS_IDENTIFIERS`). | A fixture per pattern is refused; a clean one passes; short codes and toll-free numbers (112, 108, 1800…) pass. No refused number is stored or logged. |
| 2.6 | **The `knowledge-ingest` consumer** on the bulk lane; embeds; writes chunks `PENDING`. | `verify-postgres-knowledge-ingest` (new), below. |
| 2.7 | **Publish, supersede, expire, withdraw.** The runner publishes at the effective date and expires at the expiry date. | The same gate. |
| 2.8 | **Admin view** of ingestion status and failures; re-run of a failed version. | Route tests; no file content in the view. |

### 4.2 The ingestion gate

`verify-postgres-knowledge-ingest` asserts:

1. one indexed document per version; a replayed event creates nothing and calls no provider;
2. the same bytes uploaded twice for one document are refused as a duplicate;
3. the same bytes under a second document embed nothing new (the content-hash cache);
4. **a version that is not published is never a retrieval candidate:** `PENDING`, `REJECTED`, future-dated, expired, superseded and withdrawn each get a canary, each with a positive control;
5. publishing a new version makes it `ACTIVE` and the old one `SUPERSEDED` in one transaction; a reader in between sees one or the other, never both and never neither;
6. a provider failure retries; an unparseable file ends `FAILED` with a closed code and can be re-run;
7. the bulk lane never delays a live event (the import-lane gate's own check, with knowledge events).

### 4.3 Migration

1. `knowledge_ingestion_indexes`, only if step 2.6 shows a missing index. Otherwise none.

### 4.4 Thresholds

| Measure | Threshold |
|---|---|
| Ingestion gate | Every assertion passes |
| Parsing fidelity on the synthetic document set | 100% of numbers, units and medicine names in the source text present in the chunks |
| A 50-page PDF, text layer, mock embeddings | Indexed within three runner ticks |
| Live-lane delay while ingesting 1,000 chunks | None measurable against the import-lane gate's limit |
| Everything in Phase 1 | Unchanged |

### 4.5 As built (2026-11-18)

| Step | Built | Gate |
|---|---|---|
| 2.1 | Eleven catalogued events on a new `KNOWLEDGE_DOCUMENT` aggregate (identifiers and counts only); `KnowledgeDocumentVersionUploaded` is a bulk contract, so ingestion runs on the import lane. | Emit-coverage test; catalogue regenerated; consumer registry (25 consumers); the core journey now includes an SOP |
| 2.2 | Roles `MEDICAL_SUPERINTENDENT`, `QUALITY_LEAD` (`knowledge:approve`); `HOSPITAL_ADMIN` holds `knowledge:manage`; no role holds both. Routes: `GET/POST /api/hospital/knowledge`, `POST …/versions/[versionId]/{approve,reject,withdraw,retry}`. Organisation-wide documents are managed by organisation administrators only. | `verify-postgres-knowledge-access` (38 checks, HTTP); tenancy sweep with both roles |
| 2.3 | `src/lib/knowledge/formats.ts`, `parse.ts`: PDF (pdf.js text layer), text, Markdown, HTML, CSV, JSON; bytes, name and declared type must agree; 20 MB; DOCX refused asking for a PDF export. | `parse.test.ts` per format |
| 2.4 | Normalisation that loses no number or unit (property test); running headers, footers and page numbers removed **by position** (top or bottom 7% of the page), so a body line repeated on every page is kept; hierarchical chunks with section paths and pages; tables whole with their header (split between rows, header repeated, above 1,200 tokens). | `parse.test.ts`; fidelity in the ingest gate: **94/94** numbers, units and medicine names kept across six formats |
| 2.5 | `src/lib/knowledge/identifiers.ts`: ABHA (number or address), Aadhaar-like, Indian mobile, UHID/MRN/IP/OP numbers, names with ages (English and Devanagari titles). Checked on the text, the file name, the title and the description **before anything is stored**; again at ingestion. The audit records the kinds only. | `identifiers.test.ts` (27 cases: one per pattern, clean text, 112/108/1800 numbers); both gates; e2e |
| 2.6 | `knowledge-ingest` consumer: embeds through the cache with a knowledge permit, writes the RagDocument, chunks and embeddings **PENDING with INDEXED in one transaction**; retries outages (dispatcher backoff), `FAILED` with a closed code after five attempts; re-run. Knowledge chunks are embedded by section path, heading and text, **not the title**, so the same text under another document is one cached vector. | `verify-postgres-knowledge-ingest` (62 checks) |
| 2.7 | Publish at approval or at the effective date (runner sweep); supersede in the same transaction under a lock on the document; expiry and withdrawal take the version's rows out of the index; an older version can't be published over a newer one. The knowledge search (`src/lib/rag/knowledgeSearch.ts`) admits only a version in force, checked against the version row in SQL. | The same gate |
| 2.8 | `/hospital-os/knowledge`: upload, a new version, status, re-run, withdraw; approve and reject for approvers (never their own upload). Status only: no contents, hash or storage reference. | `e2e/knowledge.spec.ts` with axe (WCAG 2.2 AA) on both screens |

**Measured (mock embeddings, local Postgres):** a 50-page text-layer PDF indexed in **one** runner tick (~0.2 s, 100 chunks); a 1,000-chunk document indexed in ~0.5 s while a live event emitted after it was delivered first; the same document under a second document **100% cache hits** (100/100); over all of the gate's documents the hit rate is 8.7% (108 of 1,239 chunks), since most of them are distinct.

**Migrations:** `20261118100000_knowledge_enum_values` (two roles, three withdraw reasons), `20261118100100_knowledge_ingestion` (file name, format, counts and times on a version; five CHECKs added NOT VALID then validated; two indexes). Phase 1's `knowledge_ingestion_indexes` placeholder wasn't needed beyond these two indexes.

**Found and fixed on the way:**
- The re-embed runner would have treated a knowledge chunk as a patient chunk with no patient (and could have called the owner-removal path for it); knowledge chunks now go through the knowledge permit and the cache, and PENDING knowledge chunks are re-embedded too.
- Embedding the title made identical text under two documents two vectors (cache hits 0); now title-free.

**Decisions taken while building** (each the more conservative option):
- **A scanned (image-only) PDF page is refused** (`NO_TEXT_LAYER`) instead of going to the OCR provider: no provider sees a knowledge page, and the document permit is person-bound. OCR for knowledge waits for a decision.
- A withdrawn or expired current version leaves the document with **no current version**; the superseded one is not restored.
- An approver may reject any waiting version; only approval is barred to the uploader.
- Every version shows "Not virus-scanned" (T-R23, no scanner procured).
- The knowledge search exists for the gates and Phase 3; no route or AI mode reads it yet, so no answer can cite a knowledge document in this phase.

## 5. Phase 3: retrieval intelligence

**Goal:** the right channel for each question; knowledge answers; honest Indic keyword search.

### 5.1 Steps

| # | Step | Gate |
|---|---|---|
| 3.1 | **Config-driven candidate counts** (today's 40/40/30/8 and 12 as defaults). | Unit tests; the evaluation is run at the spec's 30/30/20 and the better setting is kept, with both results in the pull request. |
| 3.2 | **The intent router** and entity extraction, deterministic. | A table-driven test of at least 150 phrasings, including the eleven languages for the structured intents. An unmatched question gets the full hybrid plan. |
| 3.3 | **Structured readers:** latest vitals, latest and trend per analyte, pending orders, current encounter, problems and diagnoses. | `verify-postgres-rag-readers` (new): each reader under each access path returns only what that path allows; a share's period and categories apply; a sensitive item needs its opt-in. Leak-gate canaries per reader. |
| 3.4 | **Knowledge scope and `KNOWLEDGE_QA`.** `ai:knowledge:ask`; access classes by role. | Leak gate extended: another organisation's document; another facility's; a class the role lacks; an unpublished version; **a patient canary never appears in a knowledge answer and a knowledge request never returns a patient chunk.** |
| 3.5 | **Keyword search:** the English column; trigram word similarity; the abbreviation table; canonical medicine names as extra index terms. | Unit tests from the audit's measurements. The Indic benchmark's inflected and transliterated cases meet their thresholds. |
| 3.6 | **Imported results** (§13 decision 6): `LEGACY_LAB_RESULT` indexed with origin `IMPORTED`, `STAFF_ONLY` audience; the label; ranking below verified. | `verify-postgres-ai-ask` extended: an imported value is labelled; it never appears as the "latest" value when a verified one exists; a disagreement is stated. |
| 3.7 | **Context building:** passage deduplication; neighbours; structured facts first. | Unit tests; the evaluation's citation checks. |
| 3.8 | **The evaluation set grows** to the composition in §11. | `verify-postgres-rag-eval`. |
| 3.9 | **Romanised shadow text** (§13.3 decision C, a): every Indic chunk gets a deterministic romanisation (ISO 15919 or a close scheme, rule-based, no model), indexed with pg_trgm beside the original; a Latin-script query is transliterated into each Indic script at query time and matched against the original text too. | Unit tests per script (round trips on the benchmark vocabulary); `eval:rag:indic` before and after, against the Phase 1 numbers and BGE-M3. |
| 3.10 | **A multilingual medical concept lexicon** (§13.3 decision C, b): common conditions, symptoms, tests and NLEM / WHO INN medicines, each a concept ID with its names in the eleven languages, marked **pending native-speaker and clinical review**; used only to expand a query with the same concept's other names. | Unit tests (every entry has a concept ID, a review status and no dose); `eval:rag:indic` before and after, cross-script cases included, against the Phase 1 numbers and BGE-M3. |

### 5.2 Migration

1. `legacy_result_index_support`: only what step 3.6 needs to load imported results efficiently for the indexer, if anything.

### 5.3 Thresholds

| Measure | Threshold |
|---|---|
| Correct with valid citations (mocks, whole set) | ≥ 90% |
| Expected source retrieved in the kept set | ≥ 90% overall, and ≥ 85% in every group |
| Recall@8 | ≥ the Phase 1 baseline, and ≥ 0.90 |
| MRR | ≥ the Phase 1 baseline, and ≥ 0.70 |
| nDCG@10 | ≥ the Phase 1 baseline |
| Structured-lookup questions answered by a reader (no vector search) | ≥ 95% |
| Exact medicine lookup, any script | 100% |
| Inflected and transliterated Indic keyword cases | ≥ 80% |
| Cross-script cases, beyond medicine names | **Reported, no threshold** until a multilingual model is adopted |
| Steps 3.9 and 3.10, measured separately and together in `eval:rag:indic` | Reported against the Phase 1 keyword numbers and BGE-M3; neither may lower any Phase 1 number |
| "Not in the record" correctly refused | 100% |
| Superseded or expired document retrieved | 0 |
| Leak gate | 0 |
| Retrieval latency: patient (20,000 chunks); knowledge (20,000-chunk organisation) | p95 < 150 ms each |

### 5.4 As built (2026-11-23)

| Step | Built | Gate |
|---|---|---|
| 3.1 | `ai.retrieval.{vector,keyword,rerank}_candidates`, `ai.retrieval.keep`, `ai.retrieval.keep_context` (defaults 40/40/30, 8, 12); `src/lib/rag/candidates.ts`. | `candidates.test.ts`; the evaluation compares 40/40/30 with 30/30/20 on the development split: 40/40/30 Recall@8 0.884, MRR 0.845; 30/30/20 Recall@8 0.870, MRR 0.844 — 40/40/30 kept |
| 3.2 | `src/lib/rag/router.ts`: rules in the eleven languages (pending native-speaker and clinical review) choose structured readers, narrative, mixed, knowledge or operational; an unmatched question gets the full hybrid plan. Only when two families conflict (a bed in the chart and beds in the hospital; a protocol and this patient's value) may a classifier choose, and only among the rules' candidates (`intentModel.ts`; the deterministic mock — no provider or budget). | `router.test.ts` (171 phrasings) |
| 3.3 | `src/lib/rag/readers.ts`: latest and trend per analyte, vitals, pending lab and imaging orders, the current encounter (treating team only), problems and diagnoses, from the authoritative tables. Every access condition in the SQL, sensitive categories included (the sensitivity rules as Postgres patterns). A lookup its readers fully answer skips the vector and keyword search. The NEWS2 score is not read (clinical sign-off pending). | `verify-postgres-rag-readers` (37); leak and sensitive-category gates now check readers' facts |
| 3.4 | `KNOWLEDGE_QA`: `ai:knowledge:ask` for facility staff; access classes by role (`knowledgeAccess.ts`); `POST /api/ai/knowledge/ask` through `knowledgeAsk.ts`, a reviewed provider gateway. Answers cite approved documents in force, labelled "approved document"; extractive (no model) while `ai.knowledge.external_providers` is off. | `verify-postgres-knowledge-qa` (24): another organisation, another facility, a class the role lacks, unpublished and superseded versions, patient and knowledge worlds never meet |
| 3.5 | The keyword channel (`search.ts` `keywordSql`): exact ('simple'), English stems, the shadow text, and trigram word similarity (threshold 0.4, GIN-indexed), fused by reciprocal rank; abbreviations (`abbreviations.ts`) and medicine names' variants (`medicineNames.ts`) expand the query; canonical medicine names are index terms in the shadow text. The "no record" rule still counts only the question's own words. | Unit tests; the evaluation; the Indic gate |
| 3.6 | Imported results indexed (IMPORTED, STAFF_ONLY) by the rag-indexer; the treating team reads them; never the latest when a verified value exists; a disagreement stated. | `verify-postgres-ai-ask` (52) |
| 3.7 | Structured facts first (a passage about the same row dropped); passages deduplicated; neighbours under the same heading. | `context.test.ts`; the evaluation |
| 3.8 | 230 questions (§11.1), each in the development or the held-out test split; a fixture with readers' data, imported values, three patients and a knowledge library (14 English documents with stale versions, one per Indic language). | `verify-postgres-rag-eval` |
| 3.9 | `romanize.ts` (a simplified ISO 15919 skeleton, rule-based, per script; Latin → Indic transliteration); `RagChunk.shadowText` filled by the indexer, ingestion and a bounded runner backfill. | `romanize.test.ts` (development words only); `eval:rag:indic` |
| 3.10 | `lexicon.ts`: 38 concepts (conditions, symptoms, tests, medicines) in the eleven languages, each "pending native-speaker and clinical review", no dose; used only to expand a query, matched exactly and weighted below the question's own words. | `lexicon.test.ts`; `eval:rag:indic` |

**Migrations:** `20261123100000_knowledge_identifier_rules` (§13.4), `20261123100100_rag_shadow_text`. The planned `legacy_result_index_support` was not needed.

**The evaluation** (`verify-postgres-rag-eval`, mock models, 2026-11-23; 230 questions, 117 development, 113 held out):

| Split | Recall@8 | MRR | nDCG@10 | Correct with valid citations |
|---|---|---|---|---|
| **Held-out test** (94 with a retrieval judgement) | **0.959** (target 0.90) | **0.898** (target 0.70) | 0.918 | 98/113 |
| Development (98) | 0.884 | 0.845 | 0.85 | 107/117 |
| Whole set | 0.92 | 0.87 | 0.89 | 205/230; **204/219 (93.2%) outside the cross-script cases**, which have no threshold (§5.3) |

Before and after on the same questions: the Phase 1 baseline was Recall@8 0.80 and MRR 0.64 on the 30 questions of that time (no held-out split existed); those 30 questions now score **0.847 and 0.645** (most of them are whole-record modes whose ranking Phase 3 does not change). The held-out split is new, so it has no "before". Structured lookups answered by a reader with no search: 19 of 20. Not in the record, insufficient evidence, operational and stale-document groups: all correct. What fails: the 11 cross-script knowledge questions (the mock reranker cannot relate an English question to an Indic document, so they are refused as "not in the documents"; retrieval finds them), the 10 transliterated knowledge questions (the same, for romanised Latin), and 5 others below the "no record" threshold. A real reranker is the open question; the plan's targets are unchanged.

**Settings chosen on the development split only:** the trigram threshold (0.4), the lexicon expansion's weight (0.5), the knowledge "not in the documents" threshold (0.55: answerable questions scored ≥ 0.618, unanswerable ≤ 0.504), and the candidate counts (40/40/30 kept).

**Retrieval latency** (`verify-postgres-rag-latency`, p95, 20,000 chunks): in a fresh verify:all run, patient candidate search 55 ms and the whole retrieval 63 ms (Phase 1: 59.6 ms); on this loaded laptop 95–103 ms and 114–123 ms. Knowledge retrieval over a 20,000-chunk organisation (new): 84 ms. All under 150 ms.

**Found and fixed on the way:** the knowledge search was planned generically after five runs (~230 ms; now planned per call, as the record's search has been since Phase 1); the dispatcher could skip its first round when reaping stale claims outlasted a tiny budget (its comment already said the deadline is checked between rounds); the NEWS2 score must not be read by any server code until its clinical sign-off (the vitals reader no longer reads it); the knowledge search's per-chunk in-force check cost ~0.3 s at 20,000 chunks (now applied to an oversampled candidate set, the vector and keyword branches in parallel); the leak and sensitive-category gates now check the readers' facts; a lab fixture's phone numbers repeated across runs.

**Decisions taken while building** (each the more conservative option): imported results are read by the treating team only, not through a share or organisation consent; operational questions are recognised and answered "not in the record" until operational readers exist; knowledge answers are extractive (no model) while the organisation's external-provider setting is off; the knowledge mode is not reached from chart Q&A in this phase (step 6.1); a hospital administrator reads only ALL_STAFF, BILLING and ADMIN documents through knowledge Q&A; a typing error re-ranks the exact matcher's candidates rather than searching the whole table.

**The Indic benchmark** (held-out split; `docs/RAG_INDIC_BENCHMARK.md`, Phase 3): same-script 1.00, inflected 0.97, transliterated **0.80** (from 0.00), mixed-script 0.88, cross-script 0.25 @5 / 0.28 @10, medicine in Latin 0.40; BGE-M3 1.00 / 1.00 / 0.80 / 1.00 / 0.38 @5 / 0.42. One design change was made after seeing the test split (lexicon expansions matched exactly only); it is described there with both sets of numbers.

## 6. Phase 4: token economy

**Goal:** send less, measure everything, cache only what is safe.

### 6.1 Steps

| # | Step | Gate |
|---|---|---|
| 4.1 | **Token budget** per mode and model; the estimator; refusal when structured facts alone don't fit. | Unit tests; in the evaluation, no request exceeds its budget. |
| 4.2 | **Deterministic compression.** | **Property test: every number, unit, date, medicine name, dose, route, frequency and negation in the input is in the output**, over the whole synthetic corpus. The evaluation's scores do not drop. |
| 4.3 | **Estimator calibration** per language from provider-reported usage. With mocks, from a fixed reference table. | The estimate is within 15% of the reference for each of the eleven languages. |
| 4.4 | **Embedding cache** by content hash, knowledge only. **Query-embedding cache** in Postgres, knowledge modes only. | `verify-postgres-ai-cache` (new): a patient-mode question never creates a cache row; a cache row holds no text; a hit returns the identical vector. |
| 4.5 | **Usage accounting** complete: tokens, rerank units, estimated cost, cache hits, latencies, module, intent, tier. `GET /api/ai/usage`. | Route tests by role; totals reconcile with `AiInteraction` rows; no per-user figure outside the facility's administrator. |
| 4.6 | **The client's compact context** (§13 decision 5: no server-side conversations). The request may carry a bounded summary of recent turns, kept by the screen. It shapes the wording of the question only. | `verify-postgres-ai-ask` extended: the context is size-limited and masked like a question; nothing in it can be cited or pass validation as a fact; it never widens the scope; it is stored only where the question's text is. Every turn re-runs access. |

### 6.2 Migration

None.

### 6.3 Thresholds

| Measure | Threshold |
|---|---|
| Median input tokens per answered request, per mode | At least 25% below the Phase 3 baseline, with no drop in any quality measure |
| Requests answered at Tier 0 among structured and operational questions | ≥ 90% |
| Clinical content lost by compression | 0 (the property test) |
| Requests over budget | 0 |
| Cache rows for patient-mode questions | 0 |
| Estimated cost per 1,000 queries, per mode | Reported from the price table; real figures **pending** keys |
| Quality, leak and latency thresholds from Phase 3 | Unchanged |

The 25% is a target set before measuring. If the baseline shows less room than that, the pull request says so with the numbers, and the threshold is set from them. It is not met by weakening a quality measure.

## 7. Phase 5: gateway and generation

**Goal:** one path for every AI answer, with tiers and a provider policy.

### 7.1 Steps

| # | Step | Gate |
|---|---|---|
| 5.1 | **`askAi()` restructured** into the eight steps of the architecture (§3.1), with no behaviour change for the six existing modes. | Every existing gate passes unmodified. |
| 5.2 | **Tiers.** Tier 0 answers from templates in eleven languages. | Unit tests; `verify-postgres-ai-ask`: a Tier 0 answer cites, is labelled and records zero model tokens. |
| 5.3 | **Provider registry** in the record-answer family: models, capabilities, data policy; routing by tier, risk and policy. | Unit tests: a patient-facing mode never routes below Tier 2; a provider without its flag never receives a real permit; a model id outside the allow-list falls back to the default. |
| 5.4 | **Failover** only to a provider of the same tier with the same or a stricter policy. | Unit tests with a failing mock. A real provider's failure is a 503, never the mock. |
| 5.5 | **Validation extended** to medicine names and units. | The evaluation's adversarial answers (a wrong dose, a swapped unit, a renamed medicine) all end `CITATION_INVALID`. |
| 5.6 | **`OPS_QA`** and the operational readers. | `verify-postgres-ai-ops` (new): each reader needs its screen's permission; an answer names a patient only with that permission; every answer states when it was read; another facility's state is never returned. |
| 5.7 | **`/api/chat` behind the gateway.** | `verify-postgres-ai-assistant` rewritten: a record question through `/api/chat` has the same access result, masking, validation and log as `/api/ai/ask`. |
| 5.8 | **`GET /api/ai/sources/:id`.** | A citation opens only for a caller who may read the source now. |

### 7.2 Thresholds

| Measure | Threshold |
|---|---|
| Existing gates | Pass unmodified |
| Adversarial answers caught by validation | 100% |
| Answers with an uncited factual sentence | 0 |
| Fabricated citations (a citation to a source not retrieved) | 0 |
| A real permit accepted by a provider whose flag is off | 0 |
| End-to-end latency with mocks, each mode | p95 ≤ 300 ms to the first sentence (staff) or the whole answer (patient) |

## 8. Phase 6: integration into the product

**Goal:** the layer is used where people work, in their language.

### 8.1 Steps

| # | Surface | What it gets |
|---|---|---|
| 6.1 | Doctor workspace | Chart Q&A with protocol citations; the visit brief |
| 6.2 | Nursing OS | The handoff; due and missed doses from readers |
| 6.3 | Patient portal | Explain my report, the timeline, pre-visit questions; proxies within their grant |
| 6.4 | Pharmacy, lab, radiology | `KNOWLEDGE_QA` for their access class; their own operational readers |
| 6.5 | Command centre | `OPS_QA` |
| 6.6 | Billing and administration | `KNOWLEDGE_QA` (policies); billing readers |
| 6.7 | Knowledge administration | Upload, approval queue, versions, ingestion status |
| 6.8 | Every answer panel | Labels, citations that open the source, the advisory label, right-to-left for Urdu |

Before any screen is written, the relevant guide under `node_modules/next/dist/docs/` is read: this Next.js version differs from older ones.

### 8.2 Gates

- A browser journey per surface in `e2e`, against the mocks.
- `perf:mobile`: every panel within its budget on the mobile profile.
- Accessibility: the panel passes the checks the mobile and accessibility pass established.
- Urdu: direction per line; numbers, units and Latin medicine names left to right inside it.
- The ward tablet's offline mode shows no AI panel and caches no AI response (the cache-privacy gate, extended).

### 8.3 Thresholds

| Measure | Threshold |
|---|---|
| Journeys | All pass |
| Each screen and API | p95 ≤ 300 ms (`perf:gate`) |
| Fixed phrases present in all eleven languages | 100% |
| A panel shown to a role that lacks its permission | 0 |

## 9. Phase 7: security hardening

**Goal:** every threat in [`RAG_THREAT_MODEL.md`](RAG_THREAT_MODEL.md) has a gate that fails when the mitigation is removed.

### 9.1 Steps

| # | Step | Gate |
|---|---|---|
| 7.1 | **Threat-to-gate table** completed. A threat with no gate is a blocker. | Review. |
| 7.2 | **Prompt-injection suite:** documents and record text carrying instructions (ignore your rules, reveal the prompt, cite a source you were not given, state a dose, answer about another patient, emit a link). | `verify-postgres-ai-injection` (new): no instruction is followed; no canary from outside the sources appears; every case ends in a valid answer, a refusal or `CITATION_INVALID`. |
| 7.3 | **Cache isolation.** | `verify-postgres-ai-cache` extended: two organisations, two facilities, two roles, the same question; no hit crosses. Publishing a document changes the key. |
| 7.4 | **Scholar isolation, both ways.** | A static check that Scholar modules import nothing from record or knowledge retrieval, and the reverse; a gate with canaries in each world. |
| 7.5 | **Retention and deletion.** | Text gone after its expiry; metadata after a year; a withdrawn AI consent removes the index and the source rows' link to the person; an erasure removes everything. |
| 7.6 | **Logs and errors.** | A scan of the application log after the full gate run finds no canary, no prompt, no key and no storage reference. |
| 7.7 | **Mutation checks** on the leak gate: each access predicate is removed in turn in a test build, and the gate must fail each time. | A report listing every predicate and the canary that caught it. |

### 9.2 Thresholds

| Measure | Threshold |
|---|---|
| Threats without a gate | 0 |
| Leaks across facility, organisation, patient, person, scope or cache | 0 |
| Injection cases that changed the model's behaviour | 0 with the mocks; real providers **pending** keys |
| Access predicates whose removal no canary catches | 0 |
| Canaries found in logs | 0 |

## 10. Phase 8: evaluation and production readiness

**Goal:** numbers a clinician, an administrator and an auditor can each rely on.

### 10.1 Steps

| # | Step | Output |
|---|---|---|
| 8.1 | **Full evaluation on mocks,** all groups, all languages. | The report, in the pull request and in `.eval-report`. |
| 8.2 | **Real-provider evaluation on synthetic data:** answers, embeddings, reranker. Thresholds recalibrated on the real reranker's scale. | Run if the keys work. Otherwise **pending**, and that blocks only the real-data switch, which stays off anyway. |
| 8.3 | **Embedding decision closed** from the benchmark's numbers (ADR 0005), by a new ADR that supersedes its part A. | An ADR. |
| 8.4 | **Cost benchmark:** tokens and estimated cost per 1,000 queries per mode; ingestion cost per 1,000 pages. | A table, dated, with the price table used. |
| 8.5 | **Load:** concurrent asks at the rate limits; ingestion alongside live traffic. | `perf:load` results. |
| 8.6 | **Migration test:** every RAG migration on a copy shaped like staging; a re-embed to a second mock space end to end. | `verify-postgres-rag-reembed`, and a written run. |
| 8.7 | **Recovery drill:** the index dropped and rebuilt from the record and the stored knowledge files; time recorded. | A runbook. |
| 8.8 | **Runbooks:** provider outage, dead letters, a failed ingestion, a re-embed, a suspected leak, turning the assistant off per facility. | `docs/RAG_OPERATIONS.md`. |
| 8.9 | **`PRE_LAUNCH_CHECKLIST.md` updated** with what still blocks real data. | The checklist. |
| 8.10 | **Local OCR for scanned knowledge pages** (§13.4 A): Tesseract with the Indic language packs (Hindi, Marathi, Bengali, Tamil, Telugu, Kannada, Malayalam, Gujarati, Odia, Urdu) running on our own server; no page leaves it. An external OCR provider for knowledge stays behind the per-organisation setting of §13 decision 8, **default off**. Until this step, an image-only page is refused (`NO_TEXT_LAYER`). | A gate: a scanned synthetic SOP in English and in two Indic scripts reaches the same identifier check and fidelity bar as a text-layer PDF; no network call is made during OCR. |

### 10.2 Thresholds

| Measure | Mocks | Real providers on synthetic data |
|---|---|---|
| Correct with valid citations | ≥ 90% | ≥ 90% |
| Groundedness (factual sentences supported by their citations) | 100% (the validator enforces it) | ≥ 98% by review of a sample; 100% of numbers |
| Hallucinated values (a number, dose or medicine not in a cited source) | 0 | 0 |
| Appropriate abstention on "not in the record" | 100% | ≥ 95% |
| Recall@8; MRR | ≥ 0.90; ≥ 0.70 | ≥ 0.90; ≥ 0.75 |
| Per-language recall@8, each of eleven | Reported | ≥ 0.85, or the language is listed as not supported for free-text questions |
| Leak and injection gates | 0 | 0 |
| p95 retrieval; p95 to first sentence | < 150 ms; ≤ 300 ms | < 150 ms; reported |
| Index rebuilt from the record | Completes; time recorded | — |

Real-provider figures that cannot be run are reported as **pending**. They are never estimated and never copied from the mock run.

## 11. The evaluation set and how thresholds are set

### 11.1 Composition (grown in Phase 3)

All synthetic, built through the services and the indexer like today's fixture. Expected answers are written by the team and marked "pending clinical advisor sign-off".

| Group | Count | Spec test |
|---|---|---|
| Existing set (six modes) | 30 | 1, 2, 5, 9 |
| Patient facts through structured readers (latest, trend, pending) | 20 | 1, 6 |
| Historical against current results | 10 | 2 |
| Multi-document synthesis | 10 | 3 |
| Exact medicine lookup, across scripts | 15 | 4 |
| Allergy retrieval, including "not recorded" against "no known allergies" | 8 | 5 |
| Critical results | 6 | 6 |
| Hospital SOP and policy questions | 25 | 7 |
| Facility and organisation isolation (in the leak gate) | — | 8 |
| Insufficient evidence | 12 | 9 |
| Malicious document instructions (in the injection gate) | — | 10 |
| Stale documents: superseded, expired, future-dated | 8 | 11 |
| Duplicate ingestion (in the ingestion gate) | — | 12 |
| Imported and patient-provided against verified | 8 | — |
| Operational questions | 12 | — |
| The eleven languages: at least 6 questions each, with inflected, transliterated and cross-script cases | 66 | — |

About 230 questions, some counted in two groups.

### 11.2 How a threshold is set

1. A new measure is first **recorded**, with no threshold, in the phase that introduces it.
2. In the next phase it becomes a floor: the recorded value or the number in this plan, whichever is higher.
3. A floor only moves up. Lowering one needs a written reason in the pull request and your approval.
4. A measure that cannot be evaluated with mocks (answer quality, cross-script retrieval) is reported as such. It is never given a number it has not earned.

## 12. Definition of done, mapped to phases

| # | The specification's condition | Phase | Shown by |
|---|---|---|---|
| 1 | Integrated with the existing architecture | 1–6 | No parallel entry point; existing gates unmodified |
| 2 | Structured data from authoritative services | 3 | The readers gate |
| 3 | Hybrid semantic and full-text retrieval | Exists; 3 | The evaluation |
| 4 | Asynchronous document ingestion | 2 | The ingestion gate |
| 5 | Deduplication and versioning | 2 | The ingestion gate |
| 6 | Configurable token budgets | 4 | Budget tests |
| 7 | Avoids unnecessary model calls | 4–5 | Tier 0 share |
| 8 | Safe embedding cache | 4 | The cache gate |
| 9 | Model and provider abstraction | Exists; 5 | Registry tests |
| 10 | Facility and organisation isolation at retrieval | Exists; 3, 7 | The leak gate and its mutation checks |
| 11 | Source attribution | Exists; 1, 5 | `AiInteractionSource`; the sources route |
| 12 | Insufficient evidence handled safely | Exists; 3 | "Not in the record" group |
| 13 | Clinical safety validation | Exists; 5 | Adversarial answers |
| 14 | Telemetry and cost accounting | 4 | The usage route |
| 15 | Security and regression tests pass | Every phase; 7 | All gates |
| 16 | Reproducible evaluation | 1, 3, 8 | `eval:rag` |
| 17 | Existing functionality intact | Every phase | `verify:all`, `e2e`, `perf:gate` |

## 13. Decisions before Phase 1 (decided 2026-11-17)

The twelve questions Phase 0 raised, each as decided by the product owner on 2026-11-17.

| # | Question | Decision |
|---|---|---|
| 1 | PR #16 first? | **Done.** PR #16 was merged into `main` (merge commit `1c6d535`) before Phase 1 began. |
| 2 | A self-hosted embedding service in Mumbai? | **Decided after the Phase 1 benchmark.** Nothing is adopted until it has numbers; the mock stays active (ADR 0005 part A). |
| 3 | Where knowledge chunks live | **In the existing index tables,** with the `KNOWLEDGE` owner type (ADR 0005 part B). No `KnowledgeChunk` table. |
| 4 | Who manages and who approves knowledge documents | **`knowledge.manage`** (default: hospital administrator) and **`knowledge.approve`** (default: medical superintendent, quality lead). **The approver can never be the uploader.** |
| 5 | Server-side conversations | **None in these phases.** The client keeps recent turns and sends a compact context with the question. No conversation tables. |
| 6 | Imported results in AI answers | **Staff modes only, always labelled "imported", never the "latest" value when a verified one exists.** |
| 7 | DOCX | **Deferred.** PDF, plain text, Markdown, HTML, CSV and JSON first. |
| 8 | Knowledge documents and external providers | **A per-organisation setting, default off.** A knowledge upload containing anything that looks like patient identifiers is **refused**. |
| 9 | Scholar retrieval | **Not now.** |
| 10 | Upstash Redis in the sign-in rate limiter | **Out of scope;** a separate decision. The AI layer does not use it. |
| 11 | The clinical advisor | **None yet.** Prompts, refusal rules, the sensitive-category list and the evaluation answers stay "pending clinical sign-off", and each uses the most conservative option. |
| 12 | A budget for real providers | **Pending.** The mocks stay. |

### 13.1 What the decisions change in this plan

- **Decision 4:** the permissions are written `knowledge:manage` and `knowledge:approve` in code, in the colon form every other permission uses (`ai:record:ask`). They are the two decided permissions; only the separator differs.
- **Decision 5:** step 4.6 is the client's compact context, and Phase 4 has no migration. The context is untrusted text: it is masked, size-limited, never a source, and never widens access.
- **Decision 6:** an imported result is indexed for the `STAFF_ONLY` audience, so no patient or proxy mode can retrieve it. The per-user "show imported results" chart preference is not consulted by the AI: the label and the ranking rule apply to every staff member alike.
- **Decision 8:** an Indian-mobile-shaped number counts as "looks like a patient identifier", so a document that prints one is refused, and the uploader removes it or replaces it with a short code or a toll-free number. This is stricter than Phase 0 proposed (flag for the approver).
- **Decision 11:** where a rule has a stricter and a looser reading, the stricter one is built. Patient-facing modes stay on the strongest tier, refuse diagnosis and dosing, and withhold a whole answer on any validation failure.
- **Decision 8, revised by §13.4 C (2026-11-23):** a mobile number and a 12-digit number no longer refuse a file by their shape alone. See §13.4.

### 13.2 Still open

1. ~~**The approver roles do not exist.**~~ Decided 2026-11-18 (§13.3, A).
2. **The embedding model for real data** (decision 2): not decided; §13.3, B sets what comes first.
3. **The clinical advisor** (decision 11) and **the real-provider budget** (decision 12). Both block only the real-data switch, which stays off.

### 13.3 Decisions before Phase 2 (decided 2026-11-18)

| # | Question | Decision |
|---|---|---|
| A | Who holds `knowledge:approve` | **Two new staff roles, `MEDICAL_SUPERINTENDENT` and `QUALITY_LEAD`, hold `knowledge:approve` by default; `HOSPITAL_ADMIN` holds `knowledge:manage`.** The approver can never be the uploader: the database CHECK of Phase 1 (`KnowledgeDocumentVersion_approver_check`) stays, and the service refuses first with a readable message. |
| B | The embedding service | **Not decided.** First, measure the deterministic cross-script improvements of Phase 3 (C below); then latency on Mumbai hardware once staging exists; a native-speaker review of the benchmark dataset when reviewers are available. **No model service is added until then**; the mock stays active. |
| C | Cross-script retrieval without a model | Added to Phase 3 as steps 3.9 and 3.10: (a) a **romanised shadow text** per Indic chunk (ISO 15919 or similar, deterministic), indexed with pg_trgm, plus transliteration of Latin-script queries into each Indic script at query time; (b) a **curated multilingual medical concept lexicon** (common conditions, symptoms, tests and NLEM / WHO INN medicines mapped to concept IDs across the eleven languages, marked "pending native-speaker and clinical review") used for query expansion. Both are measured in `eval:rag:indic` against the current numbers and BGE-M3. |

### 13.4 Decisions before Phase 3 (decided 2026-11-23)

| # | Question | Decision |
|---|---|---|
| A | OCR for scanned knowledge pages | **Still refused for now** (`NO_TEXT_LAYER`). A later step, **8.10**, adds local OCR: Tesseract with Indic language packs on our own server, no external provider. The per-organisation external-provider setting (§13 decision 8) stays, **default off**. |
| B | Withdrawing the version in force | **Never restores the previous version automatically.** The document then has no version in force. An administrator may **re-propose** an older version that was in force once (superseded, expired or withdrawn): the same stored file becomes the next version number, checked again under today's identifier rules, and needs the same two-person approval (the proposer cannot approve it). |
| C | The identifier check | **Refused outright:** ABHA numbers and addresses; UHID/MRN patterns; names with ages; a 12-digit number **only if it passes the Aadhaar Verhoeff checksum and does not start with 0 or 1**. Nothing of a refused file is kept. **Highlighted for the approver:** any other 12-digit number; a mobile number **not** on the facility's published contact list (switchboard, helplines, ambulance; edited by the hospital administrator, every change audited and emitted). A number on that list is allowed. The approver sees every highlight (masked to its last four digits, with its page and an excerpt) and must acknowledge each before approving; the approval records who acknowledged them and when. |

**As built (2026-11-23, the first Phase 3 commit):**

- `src/lib/knowledge/identifiers.ts`: `scanIdentifiers` returns refusals and highlights; `verhoeffValid`, `looksLikeAadhaar`; excerpts masked to the last four digits (a CHECK refuses any excerpt with seven digits in a row).
- `src/lib/knowledge/contacts.ts` and `/api/hospital/knowledge/contacts` (GET, POST; DELETE by id): the facility's published list. A facility document may print its own facility's numbers; an organisation-wide document any facility's of the organisation.
- `reproposeKnowledgeVersion` and `POST /api/hospital/knowledge/versions/[versionId]/repropose`. The rule "the same bytes once per document" now applies to uploads; a re-proposal carries a number (`reproposalSeq`), so the unique index became `(documentId, sha256, reproposalSeq)`, identical for every existing row.
- Approval takes `acknowledgedHighlightIds`, which must be exactly the version's highlights; a CHECK refuses an approved version with highlights and no acknowledgement.
- Migration `20261123100000_knowledge_identifier_rules`. Gate `verify-postgres-knowledge-identifier-rules` (54 checks); the access gate covers the new routes by role (65 checks).

