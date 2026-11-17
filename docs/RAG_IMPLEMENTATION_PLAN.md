# RAG implementation plan: phases 1–8

- **Status:** Accepted (Phase 0, 2026-11-17; the twelve questions of §13 were decided the same day). Each phase starts only after the one before it is merged.
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
13. Decisions before Phase 1 (decided 2026-11-17)

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
| "Not in the record" correctly refused | 100% |
| Superseded or expired document retrieved | 0 |
| Leak gate | 0 |
| Retrieval latency: patient (20,000 chunks); knowledge (20,000-chunk organisation) | p95 < 150 ms each |

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

### 13.2 Still open

1. **The approver roles do not exist.** The `Role` enum has `HOSPITAL_ADMIN` and no medical superintendent or quality lead. Phase 2 needs either two new roles, or a named existing role to hold `knowledge:approve`. Until one holds it, nothing can be published, which is the safe default.
2. **The embedding model for real data** (decision 2), after the benchmark.
3. **The clinical advisor** (decision 11) and **the real-provider budget** (decision 12). Both block only the real-data switch, which stays off.
