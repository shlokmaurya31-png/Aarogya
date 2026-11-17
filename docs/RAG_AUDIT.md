# RAG Phase 0: repository audit

- **Status:** Phase 0 deliverable (2026-11-17). No migrations and no feature code in this phase.
- **Branch:** `rag/phase-0`, from `main` at `d93c72a`.
- **Audited against:** the enterprise RAG specification (the "spec" below) and the Aarogya rules that override it.
- **Companions:**
  - [`RAG_ARCHITECTURE.md`](RAG_ARCHITECTURE.md): the target architecture;
  - [`RAG_IMPLEMENTATION_PLAN.md`](RAG_IMPLEMENTATION_PLAN.md): phases 1–8 and their gates;
  - [`RAG_THREAT_MODEL.md`](RAG_THREAT_MODEL.md);
  - [`adr/0005-rag-embeddings-providers-and-tables.md`](adr/0005-rag-embeddings-providers-and-tables.md);
  - [`RAG_DESIGN.md`](RAG_DESIGN.md): the Week 4b design this builds on (§16 records what was built).

## Contents

1. Summary
2. What was inspected
3. Component map: exists / extend / new
4. Reusable components
5. Incomplete implementations
6. Architectural conflicts
7. Missing infrastructure
8. Security implications
9. Database changes required
10. Dependencies that must not be introduced
11. Measurements taken in this audit

---

## 1. Summary

**A working RAG layer already exists, and it is the right base.** It covers one thing well: answers about one patient's record, with access decided in SQL before ranking, citations validated sentence by sentence, and a zero-tolerance leak gate. The spec's larger scope (knowledge documents, operational questions, token economy, usage analytics) is missing, but nothing found requires a rebuild.

The six findings that shape the plan:

1. **Extend, don't rebuild.** Of the 51 spec components mapped in §3, 23 exist, 15 need extending and 13 are new. Two new table groups are justified: knowledge documents and per-interaction source references. A third, conversations, waits for your decision.
2. **There is a second, unguarded AI path.** `POST /api/chat` (the portal assistant) builds a record context and sends it to the Scholar/assistant `AIProvider`. It has no real-data switch, no AI-consent check, no permit, no identifier masking, no citations and no interaction log. With an Anthropic key set it would send a real patient's context to Anthropic. It must come behind the gateway before real data (§6.1, §8.1).
3. **No per-provider data policy exists yet.** The real-data switch is global. With it on and consent granted, the Claude answer provider accepts real data; only Voyage refuses outright. Your rule 5 needs an explicit per-provider flag, default off (§8.2).
4. **Imported legacy results are not labelled in the AI layer** because they are not in it at all. `LegacyLabResult` is never indexed, and `RagOrigin` has only `VERIFIED` and `PATIENT_PROVIDED`. An `IMPORTED` origin is needed before they can be used (§5.4).
5. **Indic keyword search works for exact words only.** Measured on local Postgres 16.15: the `simple` configuration tokenises all ten Indic languages correctly, but an inflected word doesn't match its stem, a transliterated spelling doesn't match, and a Latin query never matches Devanagari text. `pg_trgm` fixes the first two and not the third (§11).
6. **The open flagship PR changes the schema.** PR #16 (`foundation/flagship-5`) adds 199 lines to `schema.prisma`. Phase 1's migrations must be written after it merges, or they will conflict.

## 2. What was inspected

| Area | Files |
|---|---|
| Agent rules | `CLAUDE.md`, `AGENTS.md`, `README.md` |
| Schema | `prisma/schema.prisma` (12,729 lines), 108 migrations; the RAG block at lines 11040–11340 |
| RAG code | `src/lib/rag/` (25 files, 2,369 lines), `src/lib/consumers/ragIndexer.ts` |
| AI boundary | `src/lib/ai/` (29 files): the Scholar/assistant `AIProvider`, the record-answer providers, the embeddings providers, the document providers, the real-data gate |
| Access | `src/lib/auth/hospitalRbac.ts`, `src/lib/auth/permissions.ts`, `src/lib/person/access.ts`, `src/lib/patient/context.ts`, `src/lib/sharing/` |
| Documents | `src/lib/documents/` (the 4a pipeline, 3,841 lines), `src/lib/medicines/`, `src/lib/storage/` |
| Background work | `src/lib/events/` (outbox, dispatcher, import lane, emit rule), `src/lib/runner/tick.ts`, `src/app/api/cron/tick/route.ts` |
| AI routes | `src/app/api/ai/{ask,me,interactions}`, `src/app/api/chat`, `src/app/api/student/viva` |
| Privacy | `src/lib/privacy/`, `src/lib/clinical/gateway.ts`, `docs/CLINICAL_EDUCATION_PRIVACY.md` |
| Evaluation | `eval/rag/questions.json`, `scripts/eval-rag.ts`, `scripts/verify-postgres-rag-*.ts`, `scripts/verify-postgres-ai-*.ts`, `scripts/perf-gate.ts` |
| Hosting | `docs/adr/0001`–`0004`, `docs/STAGING_SUPABASE.md`, `.github/workflows/` |
| Postgres | the local `pgvector/pgvector:pg16` container: Postgres 16.15, `vector` 0.8.7 installed; `pg_trgm` 1.6 and `unaccent` 1.1 available, not installed |

## 3. Component map: exists / extend / new

"Exists" means the spec's component is already built and gated. "Extend" means the base is there and the spec asks for more. "New" means nothing equivalent was found.

### 3.1 Gateway and query understanding (spec §4)

| Spec component | Status | What exists | What changes |
|---|---|---|---|
| AI Gateway | **Extend** | `askAi()` in `src/lib/rag/ask.ts`: rate limits → access → patient safety rules → retrieval → provider → validation → labels → log. `POST /api/ai/ask` is thin. | Add intent routing, the knowledge and operational paths, token budgets and the provider policy. **`/api/ai/ask` stays the entry point**; no reason was found for `/api/ai/query` (§6.5). |
| "No frontend calls an LLM" | **Exists** | Every provider SDK is imported only under `src/lib/ai` (ADR 0003). Callers found: `rag/ask.ts`, `documents/pipeline.ts`, `api/chat`, `api/student/viva`. | `api/chat` moves behind the gateway. |
| Intent classification | **New** | The request names its `mode` (six modes), so no classification happens today. | A deterministic router inside a mode. No LLM classifier until an evaluation shows the rules are not enough. |
| Entity extraction | **New** | The patient, share, report, appointment and period arrive as validated ids. | Deterministic extraction of analyte, medicine, date range and document type from the question, using the existing vocabularies (`documents/protect.ts`, `medicines/`). |

### 3.2 Retrieval (spec §5, §6)

| Spec component | Status | What exists | What changes |
|---|---|---|---|
| Channel 1: structured | **Extend** | "Live facts" in `retrieve.ts`: active medicines, doses due or missed (nurse), active allergies, read at request time and cited by id. | A registry of structured readers over existing services: latest vital, latest result per analyte, pending orders, current encounter. |
| Channel 2: semantic | **Exists** | `RagEmbedding` (`halfvec`, any dimension), exact cosine over one patient's rows, every access filter on the embedding row. | The same search over knowledge chunks. |
| Channel 3: full text | **Extend** | `RagChunk.tsv` (`simple`, GIN), an OR query with a small English suffix stripper (`stem.ts`). | An English-configuration column for English chunks; `pg_trgm` for Indic scripts and transliteration; an abbreviation table. |
| Channel 4: operational | **New** | The services exist (`hospital/commandCenter.ts`, `bed.ts`, `queue.ts`, `pharmacy.ts`, `inventory/`, `billing/`). The AI doesn't call them. | Thin read adapters, staff only, each behind the permission its own screen needs. Never embedded. |
| Rank fusion | **Exists** | Reciprocal-rank fusion, k = 60 (`fuse()`). | — |
| Reranking | **Exists** | The embedding space's reranker (Voyage `rerank-2`, or BM25 in the mock). | — |
| Configurable candidate counts | **Extend** | 40 vector, 40 keyword, 30 fused, 8 or 12 kept: constants in code. | Move to the config registry. The spec's 30/30/20/5–8 are starting values to be measured against these. |
| Recency, authority, origin | **Exists** | "Latest" intent boosts the newest; a verified chunk outranks a patient-provided one. | Add `IMPORTED` below `VERIFIED`; add document authority and version for knowledge. |
| Deduplication | **Extend** | Per source: one document per `(sourceType, sourceId, sourceVersion)`, with a content hash. | Passage-level deduplication across sources before the context is built. |
| Parent-document neighbours | **New** | `(documentId, chunkNo)` is unique, so neighbours are addressable. | Fetch `chunkNo ± 1` when a kept chunk is cut mid-section. |

### 3.3 Ingestion, chunking, embeddings (spec §7–§9)

| Spec component | Status | What exists | What changes |
|---|---|---|---|
| Patient-upload ingestion | **Exists** | The 4a pipeline: page preparation, OCR, translation with exact-copy protection, fact extraction, patient review, conflicts. Confirmed facts reach the index through `PatientProvidedRecordAdded`. | Nothing. The new pipeline must not duplicate it. |
| Knowledge-document ingestion | **New** | No SOP, policy or reference-document model exists anywhere in the schema. | New: upload, parse, classify, chunk, embed, approve, version. Reuses the storage adapter, upload validation, `pdfPages.ts`, `language.ts` and the OCR provider. |
| Asynchronous jobs | **Exists** | The transactional outbox, `runTick`, the bulk (import) lane, `RagBackfillCursor`, the re-embed tick. | The spec's `EmbeddingJob` table is **not** created (§9.3). |
| Idempotency | **Exists** | Same version and hash is a no-op; embeddings are `ON CONFLICT DO NOTHING`. | The same for knowledge documents, by file hash. |
| Malware scanning | **New (deferred)** | `storage/validation.ts` checks type and size and says plainly it is not a virus scanner. | An adapter slot behind ADR 0003. Not procured, so documents stay "not scanned" and the status says so. |
| Document versioning | **Extend** | `RagDocument.sourceVersion` and `status` (`ACTIVE`, `SUPERSEDED`, `WITHDRAWN`). | Approval, effective and expiry dates and the superseded-by link live on the new knowledge tables. |
| Semantic chunking | **Extend** | `chunk.ts`: 400-token target, 512 maximum, 60 overlap; sections, then paragraphs, then sentences; a sentence is never split. | Tables kept whole with their header row; page and section path on each chunk. Token counts are estimates (§5.6). |
| Embedding abstraction | **Exists** | `EmbeddingProvider` (`mock`, `voyage`, the `india-hosted` slot), chosen by the embedding space, never by a request. | A real implementation for the deferred slot, if the ADR's benchmark picks one. |
| Model and version on every vector | **Exists** | `RagEmbedding.embeddingModel`, `embeddingVersion`, `dims`; a CHECK on the dimension. | — |
| Safe re-embedding | **Exists** | `RagEmbeddingSpace` (`BUILDING` → `ACTIVE` → `RETIRED`), 100% coverage required to switch, a 7-day grace period. | — |
| Embedding cache | **Extend** | An unchanged source is never re-embedded. Identical text in two sources is embedded twice. | A content-hash lookup inside one embedding space. |
| Query-embedding cache | **New** | None. The query is embedded on every request. | Per-request memory for patient-scoped modes; a Postgres cache for knowledge questions only (§8.5). |

### 3.4 Generation, tokens, models (spec §10, §11, §14, §15)

| Spec component | Status | What exists | What changes |
|---|---|---|---|
| Provider abstraction | **Exists** | Three provider families under `src/lib/ai`, each with a mock (§4.2). | Extended, not merged (§6.2). |
| Token budgeting | **New** | Only a word limit per mode (`maxWords`) and the kept-chunk count. | A budget per mode and model, computed before generation. |
| Deterministic compression | **New** | — | Whitespace, repeated headers and duplicate facts. |
| Semantic compression | **New (deferred)** | — | Only if an evaluation shows the deterministic level is not enough. |
| Conversation memory | **New (decision needed)** | Every request is single-shot. | See the open questions. |
| Adaptive retrieval | **Extend** | "No record" is decided before the model is asked. Patient safety refusals happen before retrieval. | Skip the vector search and rerank when a structured reader answers the question. |
| Token accounting | **Extend** | `AiInteraction.inputTokens`, `outputTokens`, `latencyMs`, `model`. | Embedding tokens, rerank units, provider, estimated cost, cache hits, retrieval and generation latency, module. |
| Model tiers | **Extend** | One model key per mode (`ai/models.ts`), Claude ids only. | Tier 0 (no model) made explicit; a tier per intent. |
| Provider data policy | **New** | Only the global switch and Voyage's hard refusal. | A per-provider flag, default off. |
| Evidence validation | **Exists** | `validate.ts`: every citation must be a retrieved source; every number must occur in a cited source. | The same check for medicine names and units. |
| Source attribution | **Extend** | Citations carry chunk id, source type and id, origin, date, title and a link. `AiInteraction` keeps arrays of retrieved and cited chunk ids. | Rank, document version, page and section, kept after the chunk is deleted (§9.2). |
| Clinical safety rules | **Exists** | `safety.ts` and the mode rules: no diagnosis or dosing for patients, the emergency line for urgent symptoms, nothing written to the record. | — |

### 3.5 Security, caching, observability, evaluation (spec §13, §16, §18, §19)

| Spec component | Status | What exists | What changes |
|---|---|---|---|
| Access inside the SQL query | **Exists** | `scopeSql()` in `search.ts`: owner, categories, sensitive category, audience, origin and period, on the row being ranked. | A third owner kind for knowledge. |
| Staff access (RBAC, organisation, facility) | **Exists** | `requireFacilityStaff("ai:record:ask")`; the facility comes from the staff profile, never the request. | New permissions for knowledge and operational questions. |
| Person-level access | **Exists** | `resolveAiAccess()`: `TREATING`, `NURSE_ASSIGNED`, `SHARE`, `ORG_CONSENT`, `OWN`, `PROXY`, all through `personAccess()`, `PersonConsent`, the share's categories and the care window. | — |
| AI consent answers 404 | **Exists** | `aiAssistancePermit()`; a decline or a lapse refuses even synthetic data. | — |
| Prompt-injection defence | **Extend** | Sources are delimited quoted data; the provider has one forced output schema and no other tools. | Sanitisation of knowledge documents at ingestion; an injection test suite. |
| Caching layers | **New** | None in the AI path. | Narrow, and in Postgres or per-request memory only (§8.5). |
| Audit | **Exists** | `AiInteraction`, `AiTextReadLog`, `RECORD_ACCESSED` in the person's access log, the audit event on a space switch. | — |
| Retention | **Exists** | Text at most 90 days by a CHECK; metadata one year; both purged by the runner. | — |
| Admin and health surface | **Extend** | `GET /api/ai/interactions`, the monthly report, `embeddingCoverage()`. | A usage view and an ingestion-health view. |
| Evaluation suite | **Extend** | 30 questions, the scorer, `verify-postgres-rag-eval` (≥ 90% on both measures). | Retrieval metrics (recall, MRR, nDCG), knowledge and operational questions, all 11 languages, cost. |
| Security tests | **Exists** | `verify-postgres-rag-leaks` (28 checks, each with a positive control), `ai-ask` (39), `rag-indexer` (33), `ai-switch`. | Knowledge and cache canaries. |
| Latency gate | **Exists** | `verify-postgres-rag-latency`: p95 under **150 ms** for retrieval over a 20,000-chunk patient. `perf:gate` holds every screen and API under **300 ms**. | A knowledge-corpus case. |
| Scholar isolation | **Exists** | The Clinical Learning Data Gateway is the only source of Scholar cases; the record-answer providers are a separate family that Scholar code cannot reach. | A separate knowledge scope for Scholar, never joined to hospital rows. |

## 4. Reusable components

### 4.1 The index

- **`RagDocument`, `RagChunk`, `RagEmbedding`.** Every filter column is copied onto the chunk and, by a trigger, onto the embedding, so the vector search never joins. Vectors are half precision and stored inline.
- **`RagEmbeddingSpace`.** Exactly one `ACTIVE` space by a partial unique index. A provider change is a background job, never a migration.
- **`RagBackfillCursor`.** A resumable cursor per facility and source type.
- **The `rag-indexer` consumer.** It indexes 14 source types, and removes an owner's index on AI-consent decline, account closure and a lapse at 18.

### 4.2 The provider boundary (three families, on purpose)

| Family | Interface | Used by | Real data |
|---|---|---|---|
| Scholar and portal assistant | `AIProvider` (`provider.ts`): `patientDialogue`, `vivaExaminer`, `tutorFeedback`, `assistantReply` | `/api/student/*`, `/api/chat` | No gate (§8.1) |
| Record answers | `RecordAnswerProvider.answerFromRecord` (`record/`) | `rag/ask.ts` | Needs an `AiPermit` |
| Embeddings and rerank | `EmbeddingProvider` (`embeddings/`) | `rag/embed.ts`, `rag/retrieve.ts` | Needs an `AiPermit`; Voyage refuses a real one |
| Documents | `VisionOcrProvider`, `TranslationProvider`, `FactExtractor`, `MedicineTagger` (`documents/`) | the 4a pipeline | Needs a `ProcessingPermit` |

The permits are branded types that only the real-data gate can issue, so a provider cannot be called for data the gate refused, even by mistake.

### 4.3 Access and consent

- **`resolveAiAccess()`** (`rag/access.ts`) turns the session into a retrieval scope of segments. It has no access rules of its own.
- **`personAccess()`, `careRelationship()`** (`person/access.ts`): the sharing choice, the OPD and IPD care windows, links and closure.
- **`resolveShare()`, `ragCategoriesFor()`** (`sharing/`): a share's categories, period and sensitive opt-ins. Allergies ride with every share.
- **`aiAssistancePermit()`** (`ai/realData.ts`): the real-data switch and the per-person AI consent.

### 4.4 Documents and medicines

- **Exact-copy protection** (`documents/protect.ts`): numbers, units, doses, medicine names and analytes are replaced by placeholders before translation and restored afterwards. A translation that loses a placeholder is refused.
- **Medicine reference** (`medicines/`): NLEM 2022 and WHO INN lists.
- **Language detection** (`documents/language.ts`), PDF page handling (`pdfPages.ts`), identifier masking (`identifiers.ts`).
- **Storage** (`storage/`): local and S3 adapters, signed reads, upload validation.

### 4.5 Background work

- **The outbox** (`DomainEventOutbox`, `DomainEventDelivery`): claims with `FOR UPDATE SKIP LOCKED`, per-aggregate order, retries, dead letters, replay.
- **The bulk lane** (`bulk` on the outbox row): taken only when no live event is waiting, with its own concurrency (`EVENT_IMPORT_LANE_CONCURRENCY`).
- **`runTick`**: one bounded unit of work, called every minute on staging by `pg_cron` and `pg_net`, with a 60-second limit.
- **The emit rule** (`events/emitCoverage.ts`, `emitExemptions.ts`): CI fails when a state change neither emits a catalogued event nor carries a justified exemption.

### 4.6 Evaluation and gates

`verify-postgres-rag-models`, `-rag-indexer`, `-rag-leaks`, `-rag-latency`, `-rag-reembed`, `-rag-eval`, `-ai-ask`, `-ai-switch`, `-ai-assistant`; `eval:rag` and `eval:rag:real`; `perf:gate`.

## 5. Incomplete implementations

1. **The real-provider evaluation has never run.** `RAG_DESIGN.md` §16.8 records it as "ready, not run": the Anthropic key has no credit and there is no Voyage key. The mock result (30 of 30) checks retrieval, access, validation and labels. It says nothing about answer quality.
2. **The India-hosted embedding provider is a slot that refuses.** `embeddingProviderFor()` throws `DEFERRED` for it.
3. **Thresholds are calibrated on the mock reranker's scale** (staff 0.50, patient 0.55). They must be recalibrated on a real reranker before real data.
4. **Imported results are outside the AI layer.** `LegacyLabResult` shows on the chart's trends labelled "imported". It is not indexed, has no source type and no origin value.
5. **Only vitals are indexed among observations.** ICU, emergency reassessment and intake/output observations are not.
6. **Token counts are estimates** (a quarter of the characters, at least one per word). For Indic scripts this undercounts by an unknown factor; no measurement was found.
7. **The concurrency cap is per process** (two requests per user, in memory). On Vercel the effective cap is two per instance.
8. **The `TRANSLATED` label has no indexed source.** Translations exist only for OCR text, which is never indexed, so `RagChunk.translatedText` is always empty today.
9. **Sensitive categories, prompts, refusal rules and evaluation answers are placeholders** marked "pending clinical advisor". No advisor is named.
10. **The screens were never run in a browser** for the AI panel (§16.9 says so).

## 6. Architectural conflicts

### 6.1 Two AI entry points

`/api/ai/ask` and `/api/chat` both answer questions about a patient's record. They differ in every safety property:

| | `/api/ai/ask` | `/api/chat` |
|---|---|---|
| Real-data switch | Yes | **No** |
| Per-person AI consent | Yes | **No** |
| Permit required by the provider | Yes | **No** |
| Identifiers masked | Yes | **No** |
| Citations and number validation | Yes | **No** |
| Interaction log | `AiInteraction` | An audit event for staff only |
| Rate limit | Postgres counts | `rateLimit()` (memory, or Upstash) |
| Staff access rule | An active care relationship | The patient's facility and `clinical:chart:read` |

**Resolution:** the gateway becomes the only path. `/api/chat` keeps its URL and its general, record-free answers, and any question about a record is served by the gateway's rules. Until then it must refuse REAL data (planned as the first step of Phase 1, because it is a guard and not a feature).

### 6.2 "Use the existing `AIProvider`" against the built separation

The spec says to extend `AIProvider`. The Week 4b build deliberately made record answers a separate family, so that no Scholar code path can reach patient data and each family has its own permit. **Resolution:** keep the families. "Extend the provider abstraction" means extending `src/lib/ai` as a whole. Merging them would remove a boundary that a gate depends on.

### 6.3 Model ids are Claude-only by construction

`aiModel()` accepts only ids matching `claude-…` and falls back to the default otherwise, so a typo cannot route patient data to an unexpected model. The spec's multi-provider routing conflicts with this. **Resolution:** keep the allow-list idea and widen it per provider, each entry carrying its data policy.

### 6.4 A Redis backend already exists in the rate limiter

`src/lib/auth/rateLimit.ts` uses Upstash Redis when its two environment variables are set, and memory otherwise. Your rule 6 says no Redis. **Resolution for the AI layer:** it does not use `rateLimit()`. It counts `AiInteraction` rows, which already holds across instances. Whether to remove the Upstash backend from sign-in limiting is outside this work and is listed as an open question.

### 6.5 The spec's endpoints against the existing ones

| Spec endpoint | Decision |
|---|---|
| `POST /api/ai/query` | **Not created.** `POST /api/ai/ask` gains modes. No audit finding needs a second entry point. |
| `POST /api/ai/conversations`, `GET …/:id` | Waits for the conversation decision. |
| `POST /api/ai/documents`, `GET …/:id/status` | New, for knowledge documents (named `/api/ai/knowledge/…` so they are not confused with patient uploads). |
| `GET /api/ai/sources/:id` | New: opens a cited source after re-checking access. |
| `GET /api/ai/usage` | New, over `AiInteraction`. |
| `POST /api/ai/admin/reindex` | Exists as `rag:backfill` and `rag:reembed`; an admin route wraps them. |
| `GET /api/ai/admin/health` | New. |

### 6.6 The spec's file layout against the repository's

The spec proposes `src/lib/ai/{gateway,rag,ingestion,providers,caching,safety,observability}`. The repository keeps retrieval in `src/lib/rag` and providers in `src/lib/ai`. **Resolution:** keep both directories and add files where they belong. Nothing is moved, so no import path changes.

### 6.7 The spec's "never reset the development database" and the gates

The gates reset `aarogya_verify`, never the development database. Your consent for this task covers that database on localhost only. No gate was run in Phase 0 that needed it.

## 7. Missing infrastructure

| Missing | Needed for | Phase |
|---|---|---|
| Knowledge document tables, events, consumer, parsers | SOPs, policies, references | 1–2 |
| `KNOWLEDGE` owner and `IMPORTED` origin in the index | Knowledge retrieval; imported results | 1 |
| `pg_trgm` (by migration, in `public`) | Indic and transliterated keyword search | 1 |
| Per-provider data-policy flags | Rule 5 | 1 |
| Intent router and structured-reader registry | Channels 1 and 4 | 3 |
| Token budget, deterministic compression | Token economy | 4 |
| Usage and cost columns; the source-reference table | Accounting, attribution | 1 (schema), 4 (use) |
| An Indic retrieval benchmark | The embedding decision (ADR 0005) | 1 |
| A real implementation of the India-hosted embedding slot | Real data | After the ADR's benchmark |
| A DOCX parser | Knowledge documents in DOCX | 2 (a dependency decision) |
| A malware-scanning adapter | Spec §7 step 4 | Deferred until procured |

## 8. Security implications

### 8.1 `/api/chat` has no real-data gate (High, before real data)

Described in §6.1. Today every facility with data is `SYNTHETIC` and the Anthropic key has no credit, so nothing real has left. The risk is that nothing in code prevents it once a key works and a REAL facility exists. The threat model lists it as T-R03.

### 8.2 No per-provider policy (High, before real data)

- **Claude (record answers):** accepts a real permit when `AI_REAL_DATA_ENABLED=true` and the person consented.
- **Claude (documents):** the same, with a `ProcessingPermit`.
- **Voyage:** refuses a real permit in code.
- **Mock:** refuses a real permit.

The switch is one global boolean. It cannot express "Claude may, Voyage may not".

### 8.3 Knowledge documents are a new injection surface (High)

A patient's record is written by clinicians or confirmed by the patient. A knowledge document is an uploaded file that may contain text aimed at the model. It also reaches every staff member of a facility, where a record reaches one care team. Treated in the threat model as T-R07 and T-R08.

### 8.4 Mixing knowledge rows into PHI tables (Medium)

Putting knowledge chunks in `RagChunk` reuses the embedding spaces, the re-embed job and the search. It also means one predicate now separates three owner kinds. A mistake there leaks. The mitigation is structural: a knowledge request and a patient request never share a segment list, and the leak gate plants canaries both ways.

### 8.5 Caches can outlive a permission (Medium)

Access changes on every request today because nothing is cached. Any cache over patient data needs invalidation on consent, share, proxy, link, assignment and care-window changes, and one missed case is a leak. **Position:** no retrieval or response cache over person or patient data. Caches are limited to embeddings by content hash, and to knowledge questions, keyed by organisation, facility, role, access class, document versions and model.

### 8.6 Conversation memory is retained text (Medium)

Patient question and answer text is kept only under the `AI_TEXT_RETENTION` opt-in. A conversation table would hold exactly that text. It needs the same encryption, retention and opt-in rule, or it weakens a rule that exists today.

### 8.7 Derived vectors are personal data (Low)

An embedding of a clinical note can be partly inverted. Vectors already sit beside their text under the same access rules and are hard-deleted with it. A query-embedding cache would hold vectors of questions that may name a patient, which is why it is limited to knowledge questions.

### 8.8 Operational answers cross patients (Medium)

"Which beds are free?" is fine. "Who is in bed 12?" returns a patient. Operational readers must return counts and states by default and reuse each screen's own permission for anything that names a person.

## 9. Database changes required

Detailed, with the reasons, in ADR 0005 part B. In brief:

### 9.1 Extended

- **`RagOwnerType`**: add `KNOWLEDGE`. **`RagOrigin`**: add `IMPORTED`. **`RagSourceType`**: add `KNOWLEDGE_DOCUMENT`, `LEGACY_LAB_RESULT`. **`RagDocumentStatus`**: add `PENDING` (written, not yet published).
- **`RagDocument`, `RagChunk`, `RagEmbedding`**: an organisation column on the chunk and embedding, an access class, page and section path, an English text-search column, a trigram index; the owner CHECKs and the copy trigger extended.
- **`AiInteraction`**: module, intent, tier, provider, embedding tokens, rerank units, estimated cost, cache flags, retrieval and generation latency.
- **Config registry**: candidate counts, budgets, knowledge settings.
- **Permissions**: `ai:knowledge:ask`, `ai:knowledge:manage`, `ai:knowledge:approve`, `ai:ops:ask`, `ai:usage:read`.

### 9.2 New (each justified in the ADR)

- **`KnowledgeDocument`, `KnowledgeDocumentVersion`**: no existing table can hold an approved, versioned, facility-scoped reference document. `ClinicalDocument` and `GeneratedDocument` are per patient; `PersonDocument` is per person.
- **`AiInteractionSource`**: the arrays on `AiInteraction` cannot hold rank, version, page or section, and a chunk id stops resolving when its chunk is deleted on supersede.
- **`AiEmbeddingCache`**: content hash to vector, per embedding space, for knowledge text only.

### 9.3 Not created

- **`KnowledgeChunk`**: `RagChunk` is extended.
- **`EmbeddingJob`**: the outbox, the bulk lane and the version row's ingestion status are the job system.
- **`RAGQueryLog`**: `AiInteraction` is extended.
- **`RAGSourceReference`**: named `AiInteractionSource`, to match the model it hangs from.
- **`AIConversation`, `AIConversationMessage`**: not until you decide (open question 5).

### 9.4 Sequencing

PR #16 changes `schema.prisma`. Phase 1's migrations are written on a `main` that includes it. Adding a value to a Postgres enum cannot be used in the transaction that adds it, so enum additions are their own migration ahead of the tables and CHECKs that use them.

## 10. Dependencies that must not be introduced

| Not introduced | Reason |
|---|---|
| Redis, Upstash, Memcached | Rule 6. Caches and counters live in Postgres or per-request memory. |
| Kafka, RabbitMQ, SQS, BullMQ, Inngest, Temporal | The transactional outbox and `runTick` already do this, with ordering and replay. |
| LangChain, LangGraph, LlamaIndex | The orchestration is about 300 lines of our own code with typed permits. A framework would put provider calls outside the permit boundary. |
| Pinecone, Weaviate, Qdrant, Milvus, Chroma | ADR 0001: one Postgres. pgvector's exact scan measures 51.5 ms at p95 for 20,000 chunks. |
| Elasticsearch, OpenSearch, Meilisearch, Typesense | Postgres full-text search and `pg_trgm` cover the need. |
| A second database, or a read replica for the AI | ADR 0001. |
| Kubernetes, a separate AI microservice | Rule 6. The exception a self-hosted embedding model would need is put to you in ADR 0005, not assumed. |
| A tokenizer library per provider | Budgets use the provider's reported usage and a calibrated estimate. |
| An OCR engine (Tesseract) | The 4a OCR provider is reused. |

**Allowed, already present:** `pdfjs-dist`, `pdf-lib`, `sharp`, `@napi-rs/canvas`, `zod`, `@anthropic-ai/sdk`.

**To be decided in Phase 2:** one DOCX-to-text library, or DOCX deferred. Plain text, Markdown, HTML, CSV, JSON and PDF need no new dependency.

## 11. Measurements taken in this audit

Run on the local container (Postgres 16.15, `en_US.utf8`), in a scratch database that was created and dropped. The development database was not modified.

### 11.1 `simple` tokenises every app language into whole words

One sentence per language ("metformin 500 mg for diabetes"), through `to_tsvector('simple', …)`:

| Language | Result |
|---|---|
| Hindi, Bengali, Tamil, Telugu, Malayalam, Kannada, Gujarati, Odia, Marathi, Urdu | Whole words, combining vowel signs kept, `500` and `mg` kept as their own tokens |

No word was split at a vowel sign or a zero-width joiner.

### 11.2 What matches and what doesn't

| Case | Exact (`simple`) | Prefix (`:*`) | `similarity` | `word_similarity` |
|---|---|---|---|---|
| Marathi stem `मधुमेह` in inflected `मधुमेहासाठी` | No | Yes | 0.46 | 0.86 |
| Telugu `మధుమేహం` against `మధుమేహానికి` | No | Yes (on the shared stem) | 0.43 | 0.75 |
| Transliteration `metformin` against `metphormin` | No | No | 0.50 | 0.50 |
| Transliteration `madhumeh` against `madhumeha` | No | Yes | 0.73 | 0.89 |
| Cross-script `मेटफॉर्मिन` against `metformin` | No | No | 0.00 | 0.00 |
| Unrelated `मधुमेह` against `रक्तचाप` | No | No | 0.00 | 0.00 |

What this means for the plan:

- **Inflection and spelling variants:** `pg_trgm` word similarity separates a true variant (0.50–0.89) from an unrelated word (0.00). A threshold near 0.45 is a reasonable start, to be tuned on the evaluation set.
- **Cross-script:** no Postgres feature bridges Latin and an Indic script. It needs either a multilingual embedding model or a romanised key written at index time. The mock embedding (feature hashing of words) cannot bridge scripts either, so cross-script retrieval cannot be shown to work until a real model is benchmarked.
- **The English configuration** stems `allergies` to `allergi` and `allergic` to `allerg`. They do not meet, which is why the existing code turns stems into prefix matches. It passes Indic words through unchanged, so applying it to a mixed chunk does no harm.

### 11.3 Already measured before this audit (from `RAG_DESIGN.md` §16)

- Candidate search over a 20,000-chunk patient: p95 51.5 ms; the whole retrieval 59.5 ms; budget 150 ms.
- Storage: 65 MB for 25,000 half-precision 1024-dimension vectors.
- Evaluation with mocks: 30 of 30 correct with valid citations; 30 of 30 with the expected source retrieved.
