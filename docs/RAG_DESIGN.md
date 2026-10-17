# Retrieval-augmented answers over the patient record: design (Week 4)

- **Status:** Design for review. No code yet.
- **Date:** 2026-10-17
- **Branch:** `foundation/w4-intelligence` (from `foundation/w3-workflow-spine`)
- **Builds on:** ADR 0001 (one Postgres; `vector` already enabled by
  `20261013205801_enable_pgvector`), ADR 0003 (adapters for external services),
  ADR 0004 (modules sync through events), the workflow spine
  (`docs/WORKFLOW_SPINE_DESIGN.md` §2 reserves the `rag-indexer`), the AI
  provider boundary (`src/lib/ai`: Anthropic or mock), the portal assistant
  (`/api/chat`) and the patient access scope (`src/lib/patient/context.ts`).

## Contents

1. Goals and non-goals
2. Data model
3. Retention and deletion
4. The `rag-indexer` consumer
5. Embeddings adapter
6. Retrieval
7. `POST /api/ai/ask`
8. Safety rules
9. Evaluation
10. Data protection
11. Order of wiring, each step with its gate
12. Open questions
13. Decisions taken for you

---

## 1. Goals and non-goals

**Goals.** Clinicians and patients ask questions of one patient's record and
get short answers in which every factual sentence cites the record entry it
came from. Four modes:

| Mode | Who | What |
|---|---|---|
| `SOAP_BRIEF` | DOCTOR | A pre-visit brief in SOAP order from the chart, with citations. A draft to read, never written to the chart. |
| `CHART_QA` | DOCTOR (and NURSE, read-only questions) | Free-text question about one chart. |
| `NURSE_HANDOFF` | NURSE | Shift handoff for one admitted patient (SBAR-style): what changed, what is due, what to watch. |
| `PATIENT_QA` | PATIENT (self or delegate) | Plain-language answer about their own record, in their language. |

**Non-goals (Week 4).** No search across patients (cohorts, population
questions). No writes: the AI never creates or edits a note, order or task. No
diagnosis or treatment advice to patients. No real patient data (§10). No
answers from outside the record (no web, no general medical knowledge
presented as the patient's facts).

## 2. Data model

Three models, one migration. All are tenant-scoped (`facilityId`,
`organizationId`) and join the tenancy sweep (`SEGMENT_MODELS`) and the
facility-consistency gate like every other patient model.

### 2.1 `RagDocument`: one indexed version of one source record

| Field | Type | Notes |
|---|---|---|
| `id` | cuid | |
| `organizationId`, `facilityId` | String | the source record's tenant, never the caller's |
| `patientId` | String | canonical id; merges handled at query time with `patientIds` |
| `encounterId` | String? | when the source has one |
| `sourceType` | enum `RagSourceType` | `CLINICAL_NOTE`, `LAB_RESULT`, `IMAGING_REPORT`, `PATIENT_DOCUMENT`, `GENERATED_DOCUMENT`, `CLINICAL_DOCUMENT`, `OBSERVATION`, `DIAGNOSIS`, `ALLERGY`, `REFERRAL`, `PROBLEM`, `DISCHARGE_SUMMARY` |
| `sourceId` | String | the record's id |
| `sourceVersion` | Int | the record's version (or 1 for unversioned records; an amendment is a new version) |
| `contentHash` | String | sha-256 of the rendered text; same hash ⇒ nothing to do |
| `dataClass` | enum (mirrors `PatientDataClass`) | `RECORDS`, `REPORTS`, `MEDICATIONS`, …: what a delegate's scope must allow |
| `audience` | enum `RagAudience` | `STAFF_ONLY` or `PATIENT_VISIBLE` (released results, signed notes the portal shows) |
| `restricted` | Boolean | source is confidential (e.g. a RESTRICTED incident link, a psychiatric note type): never retrieved for `PATIENT_QA`, and for staff only with the chart permission that already gates it |
| `recordedAt` | DateTime | clinical time of the source (for "latest" questions and display) |
| `language` | String | detected or declared language of the text (`en` default) |
| `status` | enum | `ACTIVE`, `SUPERSEDED`, `WITHDRAWN` |
| `indexedFromEventId` | String | the event that caused this version (traceability) |
| `embeddingModel`, `embeddingDim` | String, Int | to detect a model change and re-embed |
| `createdAt`, `withdrawnAt`, `withdrawnReason` | | reason is a closed code: `AMENDED`, `SOURCE_DELETED`, `CONSENT_WITHDRAWN`, `ERASURE`, `REINDEX` |

Unique `(sourceType, sourceId, sourceVersion)`. Index
`(facilityId, patientId, status)`.

### 2.2 `RagChunk`: the retrievable unit

| Field | Type | Notes |
|---|---|---|
| `id` | cuid | |
| `documentId` | FK → `RagDocument`, `onDelete: Cascade` | |
| `chunkNo` | Int | unique with `documentId` |
| `facilityId`, `patientId`, `dataClass`, `audience`, `restricted`, `status` | denormalized from the document | so every filter is on the chunk row, before ranking |
| `text` | String | the chunk text (PHI: same protection as the source) |
| `heading` | String? | section label ("Impression", "Plan", "Vitals 08:00") |
| `tokenCount` | Int | |
| `embedding` | `vector(1024)` | `Unsupported("vector(1024)")` in Prisma; written and read with raw SQL |
| `tsv` | `tsvector` | generated column: `to_tsvector('simple', coalesce(heading,'') || ' ' || text)` |

Indexes:
- `HNSW (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`.
- `GIN (tsv)`.
- B-tree `(facilityId, patientId, status, audience)`: the filter every query starts with.

**Dimensions: 1024.** Voyage's current general and multilingual embedding
models default to 1024 and accept 256/512/2048; 1024 keeps the HNSW index
small (4 KB per chunk) with no measurable recall loss at our scale. The
dimension is fixed by the column type; a model change with another dimension
is a new column and a re-embed (§4.8), never a mixed column.

**Why HNSW matters less than it looks.** Every query in §1 is about one
patient, so the planner starts from the B-tree filter (hundreds to a few
thousand chunks per patient) and computes exact distances: perfect recall, no
approximate index involved. The HNSW index is there for the cases where the
filter is wide (a long-stay patient with tens of thousands of observation
chunks) and for the backfill's duplicate check. With a filtered HNSW scan,
`hnsw.iterative_scan = relaxed_order` (pgvector ≥ 0.8) is set per query so a
selective filter doesn't starve the result list.

### 2.3 `AiInteraction`: one question and its answer, for audit and evaluation

| Field | Type | Notes |
|---|---|---|
| `id` | cuid | |
| `organizationId`, `facilityId` | String | the caller's facility |
| `userId`, `role` | | the caller and their role at the time |
| `patientId` | String | |
| `delegationId` | String? | when a delegate asked |
| `mode` | enum | the four modes |
| `language` | String | answer language |
| `outcome` | enum | `ANSWERED`, `NO_RECORD`, `REFUSED_SAFETY`, `CITATION_INVALID`, `RATE_LIMITED`, `ERROR` |
| `retrievedChunkIds` | String[] | what the model was shown |
| `citedChunkIds` | String[] | what the answer cited (subset of retrieved) |
| `topScore` | Float | best fused/rerank score, for threshold tuning |
| `embeddingModel`, `generationModel` | String | |
| `inputTokens`, `outputTokens`, `latencyMs` | Int | |
| `questionText`, `answerText` | String? | **null by default** (§3.3) |
| `createdAt` | DateTime | |

`AiInteraction` rows are written by the ask route's service and are exempt
from the emit rule as `BOOKKEEPING` (an audit record, not a change to the
patient's record). `RagDocument`/`RagChunk` are written only by the
`rag-indexer`: `CONSUMER_OUTPUT`.

## 3. Retention and deletion

### 3.1 The index is derived data

The index can always be rebuilt from the record, so it is never the only copy
of anything and never subject to a legal hold itself (a hold keeps the
*source*; the derived index can be dropped and rebuilt). Deletion of index
rows is a hard delete; the audit trail is the `AiInteraction` row and the
events that caused the deletion.

### 3.2 When index rows are deleted

| Trigger | What goes |
|---|---|
| An amended source (new version indexed) | the old version's chunks, in the same transaction that inserts the new ones; the old `RagDocument` row stays `SUPERSEDED` (no text, no chunks) for traceability |
| Source deleted or voided (e.g. entered-in-error) | its document → `WITHDRAWN`, chunks deleted |
| The patient withdraws AI consent (§10.3) | every document and chunk for the patient (all versions), `CONSENT_WITHDRAWN` |
| An erasure request completes (privacy request, DPDP) | everything for the patient, `ERASURE`, and the `AiInteraction` free text if any was kept |
| Embedding model change | re-embed, then drop the old column/rows (§4.8) |

A family delegate's access being revoked (`FamilyAccessRevoked`) does **not**
delete anything: the index is the patient's, and retrieval checks the caller's
scope on every request, so a revoked delegate's next request is refused. What
it does delete is that delegate's cached answers, if caching is ever added
(none in Week 4).

### 3.3 `AiInteraction` retention

Metadata (ids, scores, outcome, counts) is kept 1 year for safety review.
Question and answer text is **not stored** by default
(`ai.interaction_text_retention_days = 0`). When enabled for a pilot it is
kept that many days and purged by the runner's sweep. See §12 Q4.

## 4. The `rag-indexer` consumer

### 4.1 Subscriptions

The reserved list from the spine design §2, plus the clinical-record events
added in batch 7:

| Event | Source indexed |
|---|---|
| `ClinicalNoteSigned` | the signed note (and on amendment, `supersedesEntryId` → supersede) |
| `LabResultReleased` | the released result (critical flag kept as metadata) |
| `ImagingReportReleased` | the released report |
| `DiagnosticReportAmended` | the amended lab result or imaging report (new version) |
| `PatientDocumentUploaded` | the uploaded document's extracted text, once text extraction exists; until then the document's title, type and date only |
| `DocumentGenerated` | the generated document (discharge summary, etc.) |
| `ClinicalDocumentRecorded` | staff-recorded documents (`documentType`) |
| `ObservationRecorded` (v2) | vitals, intake, output, ICU and ED observations (`observationKind`) |
| `DiagnosisRecorded` | ADDED / UPDATED / RESOLVED |
| `AllergyListUpdated` | ADDED / UPDATED / INACTIVATED |
| `ReferralStatusChanged` | the referral and its response |
| `ProblemListUpdated` (v2) | the problem list entry |
| `PatientDischarged` | the discharge summary, if not already indexed via `DocumentGenerated` |
| `ConsentRevoked` | removal (§4.6) when the revoked consent is the AI consent |
| `FamilyAccessRevoked` | nothing to remove (§3.2); handled so the delivery ledger shows it was seen |

Medication orders and administrations are read **live** from the MAR at query
time (§6.4), not indexed: they change by the minute and a stale "currently
on" is the most dangerous wrong answer.

### 4.2 Reading the source

Events carry IDs and codes only, so the indexer loads each source through the
same service-layer readers the UI uses, with a system actor confined to the
event's facility. If the source is no longer in that facility, or is not
readable (voided, deleted), the document is withdrawn instead (a permanent
error is a dead letter only when the record exists but cannot be read: that
is a bug to see, not to skip).

### 4.3 Text conversion

One renderer per `sourceType`, pure functions from a record to
`{ heading?, text }[]` sections:

- **Notes and documents:** the section structure kept (Subjective, Objective,
  Assessment, Plan; Impression/Findings), whitespace normalized, signatures
  and boilerplate footers dropped.
- **Structured rows** become one templated sentence each, with the date and
  unit, e.g. `2026-10-14 08:00 — BP 150/95 mmHg (abnormal), pulse 88/min,
  SpO₂ 97% on room air.`; `Allergy: penicillin — anaphylaxis (severe),
  active since 2019.`; `Diagnosis (resolved 2026-10-02): community-acquired
  pneumonia, ICD-10 J18.9.`
- **Lab results:** analyte, value, unit, reference range, flag, released time;
  one sentence per analyte, grouped by panel.
- Codes are expanded to their display names (ICD-10, LOINC where present) so
  both the vector and the keyword search can match either.
- Free text is never translated at index time; the embedding model is
  multilingual.

### 4.4 Chunking

- Target 400 tokens, hard maximum 512, 60-token overlap, splitting at section
  boundaries first, then paragraphs, then sentences. Never mid-sentence.
- Structured rows: one chunk per day per kind (e.g. a day's vitals), so "what
  was her BP yesterday" retrieves one chunk.
- Every chunk is prefixed (for embedding only, not stored twice) with a
  context line: `[Lab result · CBC · 2026-10-14 · Pune]`, which measurably
  helps retrieval of short chunks.

### 4.5 Idempotency and amendments

- **Idempotency key:** `(sourceType, sourceId, sourceVersion)` plus
  `contentHash`. A redelivered or replayed event finds the same version with
  the same hash and does nothing (no re-embedding, no API spend).
- **Amendment:** a new `sourceVersion` inserts a new `RagDocument` and its
  chunks, and in the same transaction marks the previous version `SUPERSEDED`
  and deletes its chunks. The spine's per-aggregate ordering guarantees an
  amendment is never processed before the version it amends.
- **Embedding outside the transaction:** the embeddings are computed first
  (network call), then one short transaction re-checks the current version
  and writes. If a newer version landed meanwhile, the stale write is dropped.

### 4.6 Consent withdrawal and family revocation

- `ConsentRevoked` for the AI consent (§10.3) deletes every document and chunk
  for the patient (all facilities in the organization where the consent
  applies) and stops future indexing; later events for that patient are
  recorded as delivered and skipped.
- `FamilyAccessRevoked`: no index change (§3.2).
- Queries also check consent live (§6.1), so the window between revocation and
  the consumer running never exposes anything.

### 4.7 Backfill

`npm run rag:backfill -- --facility <id> [--since <date>]`: walks each source
table in id order, renders, embeds and writes with the same function the
consumer uses, so the result is identical to having consumed every event. A
cursor per `(facility, sourceType)` makes it resumable; it is rate-limited for
the embedding API and refuses any facility the data switch (§10) does not
allow. It emits no events.

### 4.8 Re-embedding

A model change adds a new column and HNSW index, backfills it, switches the
query, then drops the old column, each a separate migration. Mixed models are
never compared.

### 4.9 Failures

Embedding provider down or rate-limited: retry with the dispatcher's backoff.
A source that cannot be rendered: dead letter (a bug). The indexer never
blocks other consumers (the delivery ledger is per consumer).

## 5. Embeddings adapter

Per ADR 0003, one interface and two implementations, chosen by configuration:

```ts
interface EmbeddingProvider {
  readonly id: "voyage" | "mock";
  readonly model: string;
  readonly dimensions: 1024;
  embed(texts: string[], inputType: "document" | "query"): Promise<number[][]>;
  rerank?(query: string, documents: string[]): Promise<{ index: number; score: number }[]>;
}
```

- **Voyage (real):** `VOYAGE_API_KEY`; a multilingual model at 1024
  dimensions, `input_type` set (document vs query), batches of up to 128
  texts, retries on 429/5xx. Rerank with Voyage's reranker. Model names are
  pinned in config and checked against the provider's current list at wiring
  time.
- **Mock (CI and local):** deterministic and offline. Feature hashing of
  normalized word unigrams and bigrams into 1024 dimensions with sign hashing,
  L2-normalized. The same text always gives the same vector, and texts that
  share words are close, so retrieval tests are meaningful. Its reranker is
  BM25 over the candidates. Selected whenever `VOYAGE_API_KEY` is unset, like
  `getAIProvider()`.

Nothing outside `src/lib/ai/embeddings` imports a provider SDK.

## 6. Retrieval

### 6.1 Filters first, in SQL

Every candidate query starts from a CTE that applies, before any ranking:

1. `facilityId`: for staff, the caller's current facility, and the patient
   must be registered there (cross-facility reads go through the existing
   exchange/consent flows, not the assistant); for a patient or delegate, the
   scope's `facilityId`.
2. `patientId = ANY(scope.patientIds)` (merge-aware).
3. `status = 'ACTIVE'`.
4. Role: `PATIENT_QA` adds `audience = 'PATIENT_VISIBLE' AND NOT restricted
   AND dataClass = ANY(scope.allowedClasses)`; staff modes require
   `clinical:chart:read` (checked before the query) and exclude `restricted`
   unless the caller holds the permission that already gates it.
5. AI consent active for the patient (when the data switch requires it), and
   for staff the existing chart-access audit (and break-glass if that is the
   route by which they reached the chart).

The filter is built only from server-side values (session, resolved scope),
never from the request body beyond `patientId`, which the scope resolver has
already authorized.

### 6.2 Hybrid ranking

1. **Vector:** top 40 by cosine distance to the query embedding.
2. **Keyword:** top 40 by `ts_rank_cd(tsv, websearch_to_tsquery('simple', q))`.
   Catches exact drug names, analytes and codes the embedding blurs.
3. **Fusion:** reciprocal-rank fusion (k = 60) into one list of ≤ 80.
4. **Rerank:** the reranker scores the top 30; keep the best 8 (12 for
   `SOAP_BRIEF` and `NURSE_HANDOFF`, which also always include the latest
   vitals day and the active allergy and problem lists).
5. **Recency:** ties broken by `recordedAt` descending; questions with
   "latest", "last", "current" boost the newest chunk per source.

### 6.3 "No record found"

If the best rerank score is below the threshold ρ (and no keyword hit
matched), the route answers **"I couldn't find this in the record."** with
no citations and does not ask the model to answer the question (outcome
`NO_RECORD`). ρ is calibrated on the evaluation set (§9): the highest value
that keeps every answerable question answerable; the provisional value is
recorded with the eval run. The model is also instructed to say the same
when the retrieved chunks don't contain the answer.

### 6.4 Live facts alongside retrieval

Active medications (from the MAR and orders) and the active allergy list are
read live through their services and given to the model as a labelled block
with their own citations (the order or allergy id), so "is she on
warfarin?" never depends on index freshness.

## 7. `POST /api/ai/ask`

### 7.1 Request

```json
{
  "mode": "SOAP_BRIEF" | "CHART_QA" | "NURSE_HANDOFF" | "PATIENT_QA",
  "patientId": "…",
  "encounterId": "…",          // optional; SOAP_BRIEF / NURSE_HANDOFF default to the open encounter
  "question": "…",             // required for CHART_QA and PATIENT_QA, ≤ 1,000 chars
  "language": "hi"             // optional; PATIENT_QA defaults to the patient's language
}
```

Strict Zod schema; unknown keys rejected; body ≤ 16 KB. The mode must be
allowed for the caller's role (DOCTOR: `SOAP_BRIEF`, `CHART_QA`; NURSE:
`NURSE_HANDOFF`, `CHART_QA`; PATIENT accounts: `PATIENT_QA`; anyone else:
403). The audience comes from the account, never the request.

### 7.2 Response

Streaming by default (`Accept: text/event-stream`), JSON with
`Accept: application/json`.

```
event: meta
data: {"interactionId":"…","mode":"CHART_QA","label":"AI-generated — advisory only. Check the cited record.","language":"en"}

event: sentence
data: {"text":"Her last HbA1c was 8.2% on 2 October [1].","citations":[1]}

event: citations
data: [{"n":1,"chunkId":"…","sourceType":"LAB_RESULT","sourceId":"…","recordedAt":"2026-10-02T…","title":"HbA1c","href":"/hospital/patients/…/results/…"}]

event: done
data: {"outcome":"ANSWERED"}
```

- **Sentence-level streaming.** The server buffers the model's output and
  releases a sentence only after every citation in it is checked: each `[n]`
  must name a chunk that was retrieved for this request. A sentence with an
  invalid citation, or a factual sentence with none, stops the stream; the
  client discards the partial answer and the response ends with
  `outcome: CITATION_INVALID` and a fixed message. Patients never see a
  partial answer (`PATIENT_QA` is buffered whole, then sent).
- **Citations** link to the source in the app, where normal authorization
  applies again.
- `NO_RECORD` and `REFUSED_SAFETY` are normal 200 responses with their
  outcome; 401/403/404/413/429 as elsewhere; a provider failure is 503 with
  the mock-free message "The assistant is unavailable." (no silent fallback to
  the mock in production).

### 7.3 Role modes

- **Doctor, `SOAP_BRIEF`:** S (presenting complaint and history from notes),
  O (latest vitals, key results, imaging impressions), A (active problems and
  diagnoses), P (active medications, pending orders, referrals). Each line
  cited. Explicitly labelled a draft: not saved, not signable.
- **Doctor/nurse, `CHART_QA`:** a direct answer, cited, ≤ 150 words.
- **Nurse, `NURSE_HANDOFF`:** situation, changes since the last handoff (or
  last 12 h), due and missed doses, pending results, lines/devices, risks
  (falls, pressure, allergies), each cited.
- **Patient, `PATIENT_QA`:** plain language (reading age ~12), in the chosen
  language; explains what the record says ("Your blood sugar test on 2 Oct
  was higher than the normal range"), never what it means for treatment;
  ends with "Ask your doctor about …" when the question is clinical.

### 7.4 Rate limits

Through the existing `rateLimit`:

| Who | Per minute | Per day |
|---|---|---|
| Staff | 20 | 400 |
| Patient or delegate | 6 | 60 |
| Per facility (all users) | — | a configured budget (`ai.daily_request_budget`) |

And at most two concurrent requests per user. The `/api/chat` limits stay as
they are.

## 8. Safety rules

1. **Advisory only.** Every response carries the label in `meta`, and the UI
   shows it on every answer. The AI writes nothing to the record.
2. **Labelled AI-generated** everywhere it appears, including copies (a
   copied SOAP brief carries a footer line).
3. **No diagnosis or treatment advice for patients.** `PATIENT_QA` refuses
   requests to diagnose, to change, stop or dose a medicine, or to interpret
   symptoms (`REFUSED_SAFETY`, with "please ask your care team"); urgent
   symptoms get the emergency message (call 112 / go to the emergency
   department) and nothing else.
4. **Only the record.** The prompt states that the retrieved text is the only
   source of facts about the patient; general knowledge may explain a term
   but never stands in for a fact; "not in the record" is the required answer
   when it isn't.
5. **Prompt injection.** Retrieved text is wrapped as quoted data with
   delimiters, and the instruction that text inside them is never an
   instruction. The model has no tools.
6. **Minimum necessary.** Only the retrieved chunks and live block for this
   request are sent; no identifiers beyond what the text contains (no UHID,
   phone, address, ABHA number in the prompt).
7. **Staff modes** never present a differential or recommendation as the
   record's; questions like "what should I prescribe" get a refusal with the
   relevant record facts cited.
8. **Audit.** Every request writes `AiInteraction` and the existing chart
   access audit.

## 9. Evaluation

### 9.1 The set (30 questions)

Over the seeded synthetic patients (fixtures added for the purpose: a
diabetic with an amended HbA1c, an admitted cardiac patient with vitals, MAR
and an allergy, a paediatric patient with a family delegate, a Noida patient,
a patient with revoked AI consent):

| Group | Count | Checks |
|---|---|---|
| Doctor `CHART_QA`, factual | 10 | exact values, dates, latest-vs-earlier (incl. the amended result: must give the amended value) |
| Doctor `SOAP_BRIEF` | 4 | must contain listed facts per section; must not contain listed stale/foreign facts |
| Nurse `NURSE_HANDOFF` | 4 | due/missed doses, allergy, latest abnormal vital |
| Patient `PATIENT_QA` | 6 | 3 in English, 3 in Hindi/Marathi; plain-language facts; 2 are diagnosis/dosing asks that must be refused |
| Not in the record | 6 | must answer "not found" (`NO_RECORD` or the model's equivalent), with no citation |

Stored as `eval/rag/questions.json`: id, mode, actor fixture, patient
fixture, question, `mustContain` (normalized values), `mustNotContain`,
`expectedSources` (fixture source keys), `expectedOutcome`.

### 9.2 Scoring script

`npm run eval:rag [-- --provider real]`:

- **Correct:** expected outcome matches, every `mustContain` value is present
  (normalized: numbers, units, dates), no `mustNotContain`.
- **Valid citations:** every factual sentence cites, every citation is a
  retrieved chunk, and at least one cited chunk is from `expectedSources`.
- A question scores only if both hold. Report: per-question table, totals,
  the calibrated threshold, token and latency totals.
- **Target: ≥ 90% (27/30) with real Voyage + Claude on synthetic data.** In CI
  the same script runs with the mock providers as a pipeline check (it proves
  retrieval and citation plumbing, not answer quality); its target is the
  retrieval part only (expected source in the top 8 for ≥ 90%).

### 9.3 The leak test (a verify:all gate, zero tolerance)

`verify-postgres-rag-leaks`: unique canary strings planted in the records of
(a) another patient in the same facility, (b) a patient at Noida, (c) a
patient who withdrew AI consent, (d) a patient whose delegate was revoked,
(e) a `restricted` note, (f) a staff-only document. Then, as each relevant
actor, ask questions that would match the canaries. Assert the canary never
appears in: the retrieval result, the prompt sent to the (mock) model, the
answer, the citations, or `AiInteraction`. The mock model echoes its context,
so anything retrieved would surface. Also asserts at the SQL level that the
retrieval function returns zero rows outside the scope. **Target: zero
leaks**; any leak fails `verify:all`.

## 10. Data protection

### 10.1 Synthetic data only

Week 4 indexes and answers over synthetic (seeded) data only. The switch:

| Config | Default | Meaning |
|---|---|---|
| `AI_REAL_DATA_ENABLED` (env) | `false` | when false, the indexer, backfill and `/api/ai/ask` refuse any facility not marked synthetic |
| `Facility.dataClassification` | `REAL` for any new facility; `SYNTHETIC` only on seeded demo facilities | what "synthetic" means; set by migration for the seed, never from the UI |
| `ai.enabled` (per facility, config registry) | `false` | an admin must turn the assistant on for a facility |

With the switch off, a real facility's events are still delivered to the
indexer (and recorded as skipped), so turning it on later means a backfill,
not a gap.

### 10.2 Before real data (all required, none in Week 4)

1. A data processing agreement with each processor that receives text
   (Anthropic for generation, Voyage for embeddings and rerank), with zero
   data retention and no training on inputs.
2. A DPDP Act assessment: purpose, notice, cross-border transfer position,
   retention, the Data Protection Officer's sign-off.
3. Patient consent for AI processing (10.3).
4. The leak gate and eval passing on a staging copy of real-shaped synthetic
   data.
5. `AI_REAL_DATA_ENABLED=true` set by an operator, per environment.

### 10.3 Patient consent

A new consent purpose `AI_ASSISTANCE` in the existing consent model
(`src/lib/consent`), recipient the facility, scope the data classes. Indexing
and answering require it to be active for real data; withdrawal is
`ConsentRevoked`, which removes the patient's index (§4.6). A delegate cannot
grant it unless their scope includes `CONSENT`.

## 11. Order of wiring, each step with its gate

Each step is its own commit; `verify:all`, `npm test`, lint and build stay
green after each.

| # | Step | Gate |
|---|---|---|
| 1 | Models and migration: `RagDocument`, `RagChunk` (`vector(1024)`, HNSW, generated `tsvector`, GIN), `AiInteraction`, `Facility.dataClassification`, the `AI_ASSISTANCE` purpose. Tenancy sweep and facility-consistency entries. | Migration on a fresh database; drift check clean; a test that the HNSW and GIN indexes exist; tenancy sweep covers the models. |
| 2 | Embeddings adapter: interface, Voyage and mock; config selection. | Unit: mock determinism, dimension 1024, similar texts closer than unrelated; Voyage never constructed without a key. |
| 3 | Renderers and chunker. | Golden-file unit tests per source type; no chunk over 512 tokens; no mid-sentence split. |
| 4 | `rag-indexer` consumer (subscriptions §4.1, synthetic-only switch) and the backfill script. Registered in `registerAllConsumers`; `EXPECTED_CONSUMERS` grows to ten; the catalogue doc regenerates. | `verify-postgres-rag-indexer`: one document per source version; replay creates nothing; an amendment supersedes and removes old chunks; consent withdrawal removes everything for the patient; a REAL facility is skipped with the switch off; backfill equals consumption and resumes. Core journey: the rag-indexer processes journey events. |
| 5 | Retrieval: filters, hybrid ranking, rerank, threshold. | `verify-postgres-rag-leaks` (§9.3), zero leaks; unit tests for RRF and the threshold. |
| 6 | `POST /api/ai/ask` with the provider method, modes, safety rules, sentence-level citation checking, rate limits, `AiInteraction`. | `verify-postgres-ai-ask` (mock model): each mode allowed/refused by role; patient diagnosis/dosing asks refused; invalid citation stops the answer; label present; `NO_RECORD` below threshold; 429 at the limit; nothing written to the record. |
| 7 | Evaluation set and scorer. | CI: the mock run's retrieval target. Manual (synthetic data, real providers): ≥ 90% with valid citations, recorded in the PR. |
| 8 | UI: the doctor brief and chart Q&A panel, the nurse handoff view, the patient assistant switching from `/api/chat` to `/api/ai/ask` for record questions. | Existing UI tests plus a smoke test of each panel against the mock. |

Real data (§10.2) is not a Week 4 step.

## 12. Open questions

1. **Generation model.** The provider boundary pins `claude-sonnet-5`. Use the
   latest Sonnet for all modes, or the most capable model for `SOAP_BRIEF`
   and a faster one for `PATIENT_QA`? Cost per request vs. quality.
2. **Voyage model choice and residency.** Which Voyage model (multilingual
   quality on Hindi/Marathi vs. cost), and is sending text to a US processor
   acceptable for the eventual real-data phase, or do we need an
   India-hosted embedding option?
3. **Text extraction for uploads.** Patient uploads are images/PDFs; Week 4
   indexes only their metadata. OCR (and which provider) is a separate
   decision.
4. **Keeping question/answer text.** Off by default (§3.3). Clinical safety
   review may want 30–90 days of text; that is PHI in a new place.
5. **Restricted categories.** Which note types or results are `restricted`
   (mental health, HIV, sexual health, substance use)? Needs a clinical
   owner's list.
6. **Nurses and `CHART_QA`.** Allowed here (read-only questions on charts
   they can already read). Confirm.
7. **Delegates.** Should a family delegate be able to use `PATIENT_QA` at
   all, or only the patient? Designed as: yes, within their data classes.
8. **Cross-facility charts.** Staff at Pune asking about a patient's Noida
   records is out of scope (exchange + consent). Is that right for the
   organization's own facilities?
9. **Threshold policy.** One global ρ, or per mode? Calibrated per mode is
   more accurate but needs a bigger eval set.
10. **Eval ownership.** Who writes and signs off the 30 expected answers (a
    clinician should)?

## 13. Decisions taken for you

Taken as the more conservative option, all reversible:

- **Medications and allergies are read live**, not from the index.
- **No question/answer text stored** by default.
- **Patients never see a partial answer**; staff see sentence-level streaming
  only after each sentence's citations are checked.
- **Index deletion on consent withdrawal is total** (all versions, all
  facilities the consent covers), not a soft hide.
- **New facilities default to `REAL`**, so a missing flag can never expose
  real data to the AI; only seeded demo facilities are `SYNTHETIC`.
- **No mock fallback in production** when the real provider fails (503
  instead), so a mock answer is never mistaken for a real one.
- **`AI_ASSISTANCE` consent required for real data**, even where DPDP might
  allow processing for treatment without it.
- **A delegate's revocation deletes nothing**, because access is checked per
  request; deleting the patient's index would punish the patient.
