# Retrieval-augmented answers over the patient record: design (Week 4b)

- **Status:** Design, revision 2, for review. No code yet.
- **Revision 2 (2026-10-17):**
  - aligned to `docs/PRODUCT_SPEC.md` feature E;
  - the open questions of revision 1 answered by product direction (§13);
  - the patient-provided records of the document pipeline (`docs/DOCUMENT_PIPELINE_DESIGN.md`) added as an index source.
- **Branch:** `foundation/w4-intelligence`
- **Builds on:**
  - ADR 0001: one Postgres; `vector` is already enabled;
  - ADR 0003: adapters for external services;
  - ADR 0004: modules sync through events;
  - the workflow spine (`docs/WORKFLOW_SPINE_DESIGN.md` §2 reserves the `rag-indexer`);
  - the AI provider boundary (`src/lib/ai`);
  - the patient access scope (`src/lib/patient/context.ts`);
  - the consent service (`src/lib/consent`);
  - nurse assignments (`NursingAssignment`).
- **Build order:** phase 4b, after the document pipeline (4a). It shares that phase's real-data switch and adapters.

## Contents

1. Goals, modes and non-goals
2. Provenance labels
3. Data model
4. Retention, encryption and deletion
5. The `rag-indexer` consumer
6. Model and embeddings adapters
7. Retrieval
8. `POST /api/ai/ask`
9. Safety rules
10. Evaluation
11. Data protection
12. Order of wiring, each step with its gate
13. Decisions on revision 1's open questions
14. Decisions taken for you
15. Open questions

---

## 1. Goals, modes and non-goals

**Goal.** Answer questions about one patient's record:
- grounded only in that record;
- every factual line cited to the entry it came from;
- every line labelled by where the entry came from (§2);
- "No record found" instead of a guess.

**Modes** (feature E, plus the nurse handoff from the Week 4 brief):

| Mode | Who may use it | Access it needs | Output |
|---|---|---|---|
| `VISIT_BRIEF` | DOCTOR | An active share to this doctor (code/QR, approved request, or treating-hospital access) covering the categories used | History relevant to the reason for the visit, in SOAP order. Every line cited and labelled. A draft to read, never written to the chart. |
| `CHART_QA` | DOCTOR; NURSE only for patients assigned to them | Doctors: treating-hospital access or a share. Nurses: an open `NursingAssignment` (`endAt` null or in the future) for this patient at the caller's facility | A direct, cited answer of at most 150 words |
| `NURSE_HANDOFF` | NURSE, assigned patients only | As `CHART_QA` | Situation, changes since the last handoff (or the last 12 h), due and missed doses, pending results, lines and devices, risks. Each cited. |
| `EXPLAIN_REPORT` | PATIENT, or a proxy with the `USE_AI` permission | The patient's own scope, or the proxy's granted categories | One report (verified or uploaded) in plain language, in the patient's language: what each value or finding is and whether the report marks it out of range. Never a diagnosis. Follow-up questions about that report are allowed. |
| `HEALTH_TIMELINE` | PATIENT, proxy with `USE_AI`; DOCTOR with a share | As above | A dated, cited summary of visits, diagnoses, results, procedures and medicines over a period, each labelled |
| `PREVISIT_QUESTIONS` | PATIENT, proxy with `USE_AI` | As above | Questions the patient may want to ask at an upcoming appointment, drawn from their record and the visit reason. Questions only, no advice. |

**Non-goals (Week 4):**
- no search across patients (cohorts or population questions);
- no writes: the AI never creates or edits a note, order, task or record entry;
- no diagnosis or treatment advice to patients or proxies;
- no real patient data (§11);
- no answers from outside the record.

## 2. Provenance labels

Every retrieved chunk carries one origin, and the answer shows it on each line:

| Label | Meaning | Source |
|---|---|---|
| `VERIFIED` | Issued and signed by a hospital in the system | released lab results, signed notes and documents, discharge summaries, diagnoses, allergies recorded by clinicians, referrals, observations |
| `PATIENT_PROVIDED` | Confirmed by the patient (or a proxy) from an upload | `PatientProvidedRecord` and patient-provided allergies (pipeline §6), linked to the original page |
| `TRANSLATED` | Shown in a language other than the original's | translation rows (pipeline §2.4); always together with the origin label of what was translated, e.g. "patient-provided · translated from Marathi" |

Rules:
- **Verified outranks patient-provided.** Where they disagree (pipeline §8), the answer gives the verified value, cites both, and says they disagree.
- **No unconfirmed facts.** An extracted fact that hasn't been confirmed is never indexed and never used as a fact. `EXPLAIN_REPORT` is the only exception: it reads the one document being explained directly, and labels it "not yet confirmed by you".
- **Exact copy in translations.** Translated text keeps medicine names, doses, units, numbers and lab values exactly as in the original (pipeline §5), and the answer quotes them from the original.

## 3. Data model

Three models in one migration. All are tenant-scoped and join the tenancy sweep and the facility-consistency gate.

### 3.1 `RagDocument`: one indexed version of one source record

| Field | Notes |
|---|---|
| `id` | |
| `organizationId`, `facilityId` | The source record's tenant, never the caller's. |
| `patientId` | Canonical id. Merges are handled at query time with `patientIds`. |
| `encounterId?` | |
| `sourceType` | `CLINICAL_NOTE`, `LAB_RESULT`, `IMAGING_REPORT`, `PATIENT_DOCUMENT`, `GENERATED_DOCUMENT`, `CLINICAL_DOCUMENT`, `OBSERVATION`, `DIAGNOSIS`, `ALLERGY`, `REFERRAL`, `PROBLEM`, `DISCHARGE_SUMMARY`, `PATIENT_PROVIDED_RECORD` |
| `sourceId`, `sourceVersion` | An amendment or correction is a new version. |
| `origin` | `VERIFIED` or `PATIENT_PROVIDED` (§2). |
| `originalLanguage` | |
| `contentHash` | sha-256 of the rendered text. The same hash means nothing to do. |
| `category` | Sharing category (`PRESCRIPTIONS`, `LABS`, `IMAGING`, `DISCHARGE_SUMMARIES`, `UPLOADS`, `CLINICAL_NOTES`, …). The consent filter matches on it. Mapping per source type in §5.3. |
| `sensitiveCategory?` | `MENTAL_HEALTH`, `SEXUAL_HEALTH`, `HIV`, …. Placeholder list, **pending clinical advisor** (§13 Q5). Null means not sensitive. |
| `audience` | `STAFF_ONLY` or `PATIENT_VISIBLE`. |
| `recordedAt` | |
| `status` | `ACTIVE`, `SUPERSEDED` or `WITHDRAWN`. |
| `indexedFromEventId` | |
| `embeddingModel`, `embeddingDim` | |
| `withdrawnAt`, `withdrawnReason` | The reason is a closed code: `AMENDED`, `SOURCE_DELETED`, `REJECTED_BY_PATIENT`, `CONSENT_WITHDRAWN`, `ERASURE`, `REINDEX`. |

- Unique on `(sourceType, sourceId, sourceVersion)`.
- Indexed on `(facilityId, patientId, status)`.

### 3.2 `RagChunk`: the unit retrieval returns

| Field | Notes |
|---|---|
| `id`, `documentId` (cascade), `chunkNo` | `(documentId, chunkNo)` is unique. |
| `facilityId`, `patientId`, `category`, `sensitiveCategory`, `origin`, `audience`, `status` | Copied from the document so every filter runs on the chunk row, before ranking. |
| `text` | The chunk in its original language (protected as PHI). |
| `translatedText?`, `translationLanguage?` | For patient-facing modes, filled when the original isn't in the patient's language. Taken from the pipeline's translation rows. |
| `heading?`, `tokenCount` | |
| `embedding` | `vector(1024)`, via `Unsupported("vector(1024)")`, read and written with raw SQL. |
| `tsv` | A generated column: `to_tsvector('simple', …)` over the original text and any translation. |

Indexes:
- HNSW on `embedding` (`vector_cosine_ops`, m 16, ef_construction 64);
- GIN on `tsv`;
- B-tree on `(facilityId, patientId, status, audience)`.

**Dimensions: 1024.** Every query is about one patient, so the planner usually filters with the B-tree first and computes exact distances. HNSW covers patients with very large records, with `hnsw.iterative_scan = relaxed_order`. A provider with another dimension needs a new column and a re-embed (§5.8); dimensions are never mixed.

### 3.3 `AiInteraction`: one request, for audit, safety review and evaluation

| Field | Notes |
|---|---|
| `id`, `organizationId`, `facilityId`, `userId`, `role` | |
| `patientId`, `proxyGrantId?`, `shareId?` | The access path used. |
| `mode`, `language`, `model` | The generation model actually used (§6.1). |
| `outcome` | `ANSWERED`, `NO_RECORD`, `REFUSED_SAFETY`, `CITATION_INVALID`, `RATE_LIMITED`, `ERROR`. |
| `retrievedChunkIds[]`, `citedChunkIds[]`, `topScore`, `threshold` | |
| `inputTokens`, `outputTokens`, `latencyMs` | |
| `questionCiphertext?`, `answerCiphertext?`, `keyVersion?` | Encrypted text, kept only under §4.3. |
| `textExpiresAt?` | |
| `createdAt` | |

- `AiInteraction` is `BOOKKEEPING` under the emit rule.
- `RagDocument` and `RagChunk` are `CONSUMER_OUTPUT` (written only by the `rag-indexer`).

## 4. Retention, encryption and deletion

### 4.1 The index is derived data

The index can always be rebuilt from the record. So:
- it is never the only copy of anything;
- deleting from it is a hard delete;
- a legal hold applies to the source, not to the index.

### 4.2 When index rows go

| Trigger | What goes |
|---|---|
| An amended or corrected source | The previous version's chunks, in the same transaction that inserts the new ones. The old document row stays `SUPERSEDED`, with no text. |
| Source voided, entered in error, or a patient-provided record withdrawn | That document goes to `WITHDRAWN` and its chunks are deleted. |
| AI consent withdrawn (§11.3) | Every document and chunk for the patient. |
| An erasure request completes | Everything for the patient, including any `AiInteraction` text. |
| An embedding model change | Re-embed, then drop the old rows or column. |

A share expiring, a proxy permission removed, or family access revoked deletes nothing. Access is checked on every request, so the next request is refused.

### 4.3 Question and answer text

- **Staff modes:** the text is kept for safety review.
  - It is encrypted at the application level with AES-256-GCM, under a key from the environment and its KMS.
  - `keyVersion` allows key rotation.
  - It is kept for `ai.staff_text_retention_days` (default **90**), then purged by the runner's sweep.
  - Only an `AI_SAFETY_REVIEWER` permission can decrypt it, and every decryption is audited.
- **Patient and proxy modes:** no text is kept unless the patient opts in. The opt-in is its own consent purpose, `AI_TEXT_RETENTION`, with its own DPDP notice. With the opt-in, the same encryption and retention apply. Without it, only metadata is kept.
- **Metadata** (ids, scores, outcome, counts) is kept for 1 year.

## 5. The `rag-indexer` consumer

### 5.1 Subscriptions

| Event | What is indexed |
|---|---|
| `ClinicalNoteSigned` | The signed note (`supersedesEntryId` triggers supersede). |
| `LabResultReleased`, `ImagingReportReleased`, `DiagnosticReportAmended` | Released results and reports, and their amendments. |
| `DocumentGenerated`, `ClinicalDocumentRecorded` | Generated and staff-recorded documents. |
| `ObservationRecorded` (v2) | Vitals, intake, output, ICU and ED observations. |
| `DiagnosisRecorded`, `AllergyListUpdated`, `ProblemListUpdated` (v2), `ReferralStatusChanged` | Structured clinical entries. |
| `PatientDischarged` | The discharge summary, unless `DocumentGenerated` already indexed it. |
| `PatientProvidedRecordAdded`, `PatientProvidedRecordUpdated` (pipeline §4) | Confirmed facts from uploads, labelled `PATIENT_PROVIDED`. |
| `DocumentTranslated` (pipeline §4) | Fills `translatedText` on that document's chunks. Never creates facts. |
| `PatientDocumentUploaded` | Title, type and date only, until its facts are confirmed. |
| `ConsentRevoked` | Removal, when the revoked consent is the AI consent (§11.3). |
| `FamilyAccessRevoked`, proxy and share expiry events | Recorded as seen; nothing is removed (§4.2). |

Medications and allergies are **also read live** at query time (§7.4) and given to the model with their own citations.

### 5.2 Reading the source

Events carry IDs and codes only. The indexer loads each source through the service-layer readers, as a system actor confined to the event's facility. A source that is gone or voided is withdrawn. A dead letter means a bug: the source exists but cannot be read.

### 5.3 Categories, sensitivity and text

- **Renderers.** One renderer per `sourceType` turns the source into heading/text sections:
  - notes keep their sections;
  - a structured row becomes one templated, dated sentence;
  - a lab result becomes one sentence per analyte, with unit, range and flag;
  - codes are expanded to display names.
- **Category.** Each source type maps to a sharing category:
  - prescriptions and medication orders → `PRESCRIPTIONS`;
  - lab results → `LABS`;
  - imaging reports → `IMAGING`;
  - discharge summaries → `DISCHARGE_SUMMARIES`;
  - patient-provided records and uploads → `UPLOADS`, plus the fact's own category (a patient-provided lab value is both `UPLOADS` and `LABS`, and needs both to be shared);
  - notes → `CLINICAL_NOTES`.
- **Sensitivity.** `sensitiveCategory` comes from the source's codes (diagnosis code ranges, test codes, note types) through a mapping table. That table is the placeholder list, pending the clinical advisor.

### 5.4 Chunking

- Chunks aim for 400 tokens, with a hard maximum of 512 and a 60-token overlap.
- Splits happen at sections first, then paragraphs, then sentences. A sentence is never split.
- Structured rows are grouped as one chunk per day per kind.
- Before embedding, each chunk is prefixed with a context line such as `[Lab result · CBC · 2026-10-14 · verified]`.

### 5.5 Idempotency and amendments

- **Key:** `(sourceType, sourceId, sourceVersion)` plus `contentHash`.
  - A redelivery or replay finds the same version with the same hash and does nothing (no API spend).
- **New version:** inserts the new document and chunks and supersedes the old one in one transaction. Per-aggregate ordering means an amendment is never processed before its predecessor.
- **Embeddings** are computed before the write transaction. The write then re-checks the current version and drops a stale write.

### 5.6 Consent and access changes

- **`ConsentRevoked` for the AI consent:**
  - deletes the patient's whole index;
  - stops future indexing;
  - later events for that patient are recorded and skipped.
- **Share, proxy and family-access changes:** nothing to delete. Retrieval checks access live (§7.1).

### 5.7 Backfill

`npm run rag:backfill -- --facility <id> [--since <date>]`:
- uses the consumer's own function, so the result matches having consumed every event;
- has a resumable cursor per `(facility, sourceType)`;
- is rate-limited;
- refuses facilities that the data switch doesn't allow;
- emits no events.

### 5.8 Re-embedding and failures

- **Model change:** a new column and index, a backfill, a switch of the query, then the old column is dropped. Each is a separate migration.
- **Provider down:** retried with backoff.
- **Unrenderable source:** dead letter.

## 6. Model and embeddings adapters

### 6.1 Generation and helper models, configurable per mode

| Use | Default model | Config key |
|---|---|---|
| `VISIT_BRIEF`, `CHART_QA`, `NURSE_HANDOFF`, `HEALTH_TIMELINE` (doctor) | Claude Sonnet 5.5 (`claude-sonnet-5-5`) | `ai.model.<mode>` |
| `EXPLAIN_REPORT`, `HEALTH_TIMELINE` (patient), `PREVISIT_QUESTIONS` | Claude Sonnet 5.5 | `ai.model.<mode>` |
| Extraction, translation, tagging (pipeline; query-language detection here) | Claude Haiku 5.5 (`claude-haiku-5-5`) | `ai.model.extraction`, `ai.model.translation`, `ai.model.tagging` |

- Calls go through the existing `src/lib/ai` provider boundary, extended with an `answerFromRecord` method.
- Model ids live in the config registry, so changing a model is a config change, audited like any other.
- With no key, the mock provider runs (CI and local). In production a provider failure returns 503, never the mock.

### 6.2 Embeddings and rerank

```ts
interface EmbeddingProvider {
  readonly id: "voyage" | "india-hosted" | "mock";
  readonly model: string;
  readonly dimensions: 1024;
  embed(texts: string[], inputType: "document" | "query"): Promise<number[][]>;
  rerank?(query: string, documents: string[]): Promise<{ index: number; score: number }[]>;
}
```

- **Voyage:** a multilingual model at 1024 dimensions, plus its reranker. Used for synthetic data.
- **India-hosted:** a slot for an embedding model served in an Indian region, behind the same interface. It must produce 1024 dimensions, or adding it is a re-embed.
  - Before real data: check the DPDP cross-border transfer rules for each processor.
  - If Voyage isn't allowed, this provider becomes the default for real-data facilities.
- **Mock:** deterministic and offline.
  - Feature hashing of word unigrams and bigrams into 1024 dimensions, L2-normalized.
  - Its reranker is BM25.
  - Selected whenever no provider key is set.

## 7. Retrieval

### 7.1 Filters first, in SQL

Every query starts from a CTE built only from server-side values:

1. **Access path:**
   - **Treating facility:** the caller's facility, with the patient registered there.
   - **Another facility in the same organization:** only with the patient's consent.
   - **Share:** the share's facility or doctor, the categories it covers, and its date range.
   - **Proxy:** the proxy's granted categories and the `USE_AI` permission.
   - **Patient:** their own scope.
2. **Patient:** `patientId = ANY(scope.patientIds)`.
3. **Status:** `status = 'ACTIVE'`.
4. **Category:** `category` within what the access path allows.
5. **Sensitive categories:**
   - excluded unless the patient opted that category in for this share or proxy;
   - excluded for every patient-facing mode where a proxy is asking, unless allowed;
   - for staff with treating access, the existing chart permission still decides.
6. **Audience:** patient-facing modes require `audience = 'PATIENT_VISIBLE'`.
7. **Role:**
   - a nurse requires an open `NursingAssignment` for this patient at the caller's facility;
   - `VISIT_BRIEF` requires an active share or treating access.
8. **AI consent:** must be active when the facility holds real data (§11).

The request supplies only `patientId`, `mode` and the question. Everything else comes from the session and the resolved scope.

### 7.2 Hybrid ranking

1. **Vector:** the top 40 chunks.
2. **Keyword:** the top 40 by `ts_rank_cd` (`websearch_to_tsquery('simple', q)`).
3. **Fusion:** reciprocal-rank fusion (k = 60).
4. **Rerank:** the top 30, keeping 8. `VISIT_BRIEF`, `NURSE_HANDOFF` and `HEALTH_TIMELINE` keep 12 and always add:
   - the latest vitals day;
   - the active allergy and problem lists;
   - the live medication block.
5. **Ties:** broken by recency. "Latest", "last" and "current" boost the newest version of each source.
6. **Origin:** a verified chunk ranks above a patient-provided chunk on the same subject (§2).

### 7.3 "No record found", per mode

- Each mode has its own threshold `ρ_mode` on the best rerank score. If the best score is below it and no keyword hit matched, the answer is "I couldn't find this in the record." The model is not asked.
- **Patient modes are stricter:** their thresholds are calibrated to a precision target at least as high as the staff modes', and set no lower than the staff threshold.
- Thresholds are calibrated on the evaluation set (§10) and stored in config (`ai.threshold.<mode>`). Each eval report records the values in force.

### 7.4 Live facts

Active medications (orders and the MAR) and the active allergy list, including patient-provided allergies, are read live, labelled and cited by id. "Is she on warfarin?" never depends on how fresh the index is.

## 8. `POST /api/ai/ask`

### 8.1 Request

```json
{
  "mode": "VISIT_BRIEF" | "CHART_QA" | "NURSE_HANDOFF" | "EXPLAIN_REPORT" | "HEALTH_TIMELINE" | "PREVISIT_QUESTIONS",
  "patientId": "…",
  "shareId": "…",           // VISIT_BRIEF / doctor HEALTH_TIMELINE via a share
  "documentId": "…",        // EXPLAIN_REPORT: the report to explain
  "appointmentId": "…",     // PREVISIT_QUESTIONS, optional VISIT_BRIEF visit reason
  "question": "…",          // CHART_QA, and follow-ups in EXPLAIN_REPORT; ≤ 1,000 chars
  "period": { "from": "…", "to": "…" },  // HEALTH_TIMELINE
  "language": "mr"          // patient modes; default: the patient's language
}
```

- The schema is strict Zod: unknown keys are rejected and the body is at most 16 KB.
- The caller's role and access path decide which modes are allowed (§1). Anything else is a 403.

### 8.2 Response

- **Formats:** server-sent events by default; JSON with `Accept: application/json`.
- **Event sequence:**
  1. `meta`: interaction id, mode, the label "AI-generated — advisory only. Check the cited record.", and the language;
  2. `sentence` events: each with its text, citation numbers and origin labels;
  3. `citations`: for each, chunk id, source type and id, origin (`VERIFIED` / `PATIENT_PROVIDED`), `translated`, recordedAt, title, and an in-app link;
  4. `done`: the outcome.
- **Sentence-level streaming (staff modes):**
  - the server releases a sentence only after every citation in it names a retrieved chunk;
  - a factual sentence with no citation, or with an invalid one, ends the answer with `CITATION_INVALID`.
- **Patient and proxy modes** are buffered whole, validated, then sent. They never show a partial answer.
- **Status codes:**
  - `NO_RECORD` and `REFUSED_SAFETY` are 200;
  - 401, 403, 404, 413 and 429 as elsewhere;
  - 503 when the provider is down.

### 8.3 Rate limits

| Who | Per minute | Per day |
|---|---|---|
| Staff | 20 | 400 |
| Patient or proxy | 6 | 60 |
| Per facility | — | `ai.daily_request_budget` |

At most two concurrent requests per user.

## 9. Safety rules

1. **Advisory only.** Every answer is labelled AI-generated, in the response and in the UI, including copied text. Nothing is written to the record.
2. **No diagnosis for patients or proxies.**
   - `EXPLAIN_REPORT` explains what the report states and what its own reference ranges mark.
   - It refuses to diagnose, to interpret symptoms, or to change, stop or dose a medicine (`REFUSED_SAFETY`, with "please ask your care team").
   - For urgent symptoms it gives the emergency message (112, or the emergency department) and nothing else.
   - `PREVISIT_QUESTIONS` produces questions, never advice.
3. **Only the record.** The prompt states that the retrieved text is the only source of facts about the patient. "Not in the record" is the required answer when it isn't there.
4. **Exact values.** Numbers, doses, units, medicine names and lab values are quoted from the original, never from a translation (pipeline §5). A validator checks every number in the answer against the cited chunks; a mismatch is `CITATION_INVALID`.
5. **Disagreements are shown.** When a verified and a patient-provided entry conflict, both are cited and the conflict is stated.
6. **Prompt injection.** Retrieved text and uploaded documents are delimited, quoted data. The model has no tools.
7. **Minimum necessary.** No UHID, phone number, address or ABHA number goes into a prompt.
8. **Children.** Answers about a minor go only to their guardian proxies and the treating clinicians. Nothing is used for profiling.
9. **Clinical advisor sign-off is required before any mode is enabled for real data:** each mode's prompt, the refusal rules, the sensitive list and the evaluation answers.

## 10. Evaluation

### 10.1 The set (30 questions, synthetic fixtures)

| Group | Count | Checks |
|---|---|---|
| `VISIT_BRIEF` | 4 | Required facts per section. No facts from outside the share's categories or date range. Origin labels correct. |
| `CHART_QA` (doctor) | 8 | Exact values and dates; the latest value vs an earlier one; the amended value; a verified-vs-patient-provided conflict stated |
| `CHART_QA` / `NURSE_HANDOFF` (nurse, assigned) | 4 | Due and missed doses, allergy, latest abnormal vital |
| `EXPLAIN_REPORT` | 5 | Values quoted exactly. Two in Hindi or Marathi. One uploaded report. One diagnosis ask that must be refused. |
| `HEALTH_TIMELINE` / `PREVISIT_QUESTIONS` | 3 | Dated, cited, labelled. Questions contain no advice. |
| Not in the record | 6 | `NO_RECORD` (three of them in patient modes) |

The expected answers are written by the team and marked **"pending clinical advisor sign-off"** in `eval/rag/questions.json`. No mode is enabled for real data until they are signed.

### 10.2 Scoring

`npm run eval:rag [-- --provider real]`. A question scores only if both hold:
- **Correct:**
  - the expected outcome;
  - every required value present, matched exactly after normalization;
  - no forbidden content.
- **Cited:**
  - every factual sentence cites;
  - every citation was retrieved;
  - at least one citation is an expected source;
  - origin labels are correct.

**Targets:**
- with real providers on synthetic data: **at least 90%** (27/30);
- the CI mock run: expected source in the top 8 for at least 90%, which checks the retrieval plumbing.

The report also gives the per-mode thresholds, tokens and latency.

### 10.3 Leak gate (`verify-postgres-rag-leaks`, zero tolerance)

Canary strings are planted in records the caller must not see:
- another patient;
- a Noida patient;
- a patient whose AI consent was withdrawn;
- a category outside the share;
- an entry outside the share's date range;
- a sensitive category that wasn't opted in;
- an expired share;
- a proxy without `USE_AI` or without the category;
- a nurse's unassigned patient;
- a same-organization facility without consent;
- an unconfirmed extracted fact.

For each, the gate asks as the relevant actor and asserts that the canary never appears in:
- the retrieval result;
- the prompt;
- the answer;
- the citations;
- `AiInteraction`.

It also asserts at the SQL level that zero rows come back outside the scope. The mock model echoes its context, so anything retrieved would surface.

## 11. Data protection

### 11.1 Synthetic only, behind one switch

The same switch as the pipeline:

| Setting | Default | Meaning |
|---|---|---|
| `AI_REAL_DATA_ENABLED` (env) | `false` | When false, the indexer, backfill and `/api/ai/ask` refuse any facility not marked `SYNTHETIC`. |
| `Facility.dataClassification` | `REAL` for every new facility; `SYNTHETIC` only for the seeded demo facilities (set by migration) | |
| `ai.enabled` (per facility) | `false` | An admin turns the assistant on per facility. |

With the switch off, a real facility's events are still delivered and recorded as skipped. Turning it on later means a backfill, not a gap.

### 11.2 Before real data (none of this is in Week 4)

1. A data processing agreement with each processor (Anthropic; Voyage or the India-hosted provider): zero retention, no training on inputs.
2. A DPDP assessment covering:
   - purpose and notice;
   - cross-border transfer for each processor (§6.2);
   - retention;
   - the Data Protection Officer's sign-off.
3. Patient consent for AI processing (§11.3).
4. Clinical advisor sign-off (§9.9).
5. The leak gate and the evaluation run on a real-shaped synthetic copy.
6. The switch set by an operator, per environment.

### 11.3 Consent purposes

New purposes in the existing consent model:
- `AI_ASSISTANCE`: AI over this patient's record, scoped by category;
- `AI_TEXT_RETENTION`: keeping patient-side question and answer text (§4.3).

Rules:
- For a minor, the guardian consents.
- A proxy grants `AI_ASSISTANCE` only if their permissions include consent.
- Withdrawing `AI_ASSISTANCE` emits `ConsentRevoked`, which removes the patient's index (§5.6).

## 12. Order of wiring, each step with its gate

Each step is its own commit. `verify:all`, `npm test`, lint and build stay green after each. Steps 1–2 are shared with the document pipeline, and whichever phase comes first builds them.

| # | Step | Gate |
|---|---|---|
| 1 | The real-data switch: `Facility.dataClassification`, `ai.enabled`, the `AI_ASSISTANCE` and `AI_TEXT_RETENTION` consent purposes | Unit tests and `verify-postgres-ai-switch`: a REAL facility is refused everywhere while the switch is off. |
| 2 | Model config per mode, and the provider boundary extended (`answerFromRecord`) with the mock | Unit tests: the model is chosen from config; no real provider without a key. |
| 3 | Models and migration: `RagDocument`, `RagChunk` (vector, HNSW, tsvector, GIN), `AiInteraction` with encrypted text fields | Migration on a fresh database; drift check; index-existence test; tenancy sweep. |
| 4 | Embeddings adapter: Voyage, the India-hosted slot, the mock | Unit tests: determinism, 1024 dimensions, similar texts closer than unrelated ones. |
| 5 | Renderers, categories and the sensitivity mapping (the placeholder list), chunker | Golden-file tests per source type; every source type maps to a category. |
| 6 | The `rag-indexer` (§5.1) and backfill; `EXPECTED_CONSUMERS` gains it; the catalogue doc regenerates | `verify-postgres-rag-indexer`: one document per version; replay creates nothing; supersede on amendment; consent withdrawal removes everything; REAL facility skipped; backfill matches consumption. The core journey covers the indexer. |
| 7 | Retrieval: filters, hybrid ranking, origin ranking, per-mode thresholds | `verify-postgres-rag-leaks` (§10.3): zero leaks. Unit tests for fusion and thresholds. |
| 8 | `POST /api/ai/ask`: modes, access paths, safety rules, number validator, streaming, rate limits, encrypted text retention | `verify-postgres-ai-ask` (mock model): each mode allowed or refused per role and access path; a nurse's unassigned patient refused; patient diagnosis and dosing asks refused; an invalid citation or number stops the answer; label present; `NO_RECORD` below threshold; 429 at the limit; no text kept without opt-in; nothing written to the record. |
| 9 | Evaluation set and scorer | CI: the mock retrieval target. Manually, with real providers on synthetic data: at least 90%, recorded in the PR. |
| 10 | UI: the doctor visit brief and chart Q&A, the nurse panel, the patient explain/timeline/pre-visit screens, the proxy switcher | UI tests and a smoke test per mode against the mock. |

## 13. Decisions on revision 1's open questions (product direction, 2026-10-17)

| # | Question | Decision |
|---|---|---|
| 1 | Generation model | Configurable per mode. Sonnet 5.5 for doctor briefs and Q&A; Haiku 5.5 for extraction, translation and tagging (§6.1). |
| 2 | Voyage and residency | Voyage is fine for synthetic data. Before real data: check the DPDP cross-border rules, and keep an India-hosted embedding option behind the same adapter (§6.2). |
| 3 | OCR for uploads | Yes, it is core: `docs/DOCUMENT_PIPELINE_DESIGN.md`. |
| 4 | Keeping question/answer text | Kept for staff, encrypted, with a retention limit, for safety review. Patients' text only if they opt in (§4.3). |
| 5 | Restricted types | A placeholder list, marked "pending clinical advisor" (§3.1, §5.3). |
| 6 | Nurses | Chart Q&A only for patients assigned to them (§1, §7.1). |
| 7 | Family proxies | May use the assistant within their granted permissions (`USE_AI`, plus categories). |
| 8 | Cross-facility within an organization | Only with the patient's consent (§7.1). |
| 9 | "No record found" threshold | One per mode; patient modes stricter (§7.3). |
| 10 | Evaluation answers | Written by the team, marked "pending clinical advisor sign-off" (§10.1). |

## 14. Decisions taken for you

All take the more conservative option and can be reversed.

- **Free-form patient Q&A is dropped.** Revision 1 had `PATIENT_QA`. Feature E lists explain-my-report, the timeline and pre-visit questions, so open patient questions are allowed only as follow-ups inside `EXPLAIN_REPORT`, about that report.
- **The nurse handoff is kept** from the Week 4 brief, limited to assigned patients like chart Q&A.
- **Doctor patient-provided facts:** a doctor sees patient-provided facts only when the share includes `UPLOADS`, and the fact's own category too.
- **Unconfirmed extracted facts** are never indexed. Only `EXPLAIN_REPORT` reads the one document being explained, labelled as unconfirmed.
- **Staff text retention defaults to 90 days.** Decryption needs a dedicated permission and is audited.
- **Sonnet 5.5 for all patient-facing modes,** not Haiku. Patient explanations need the stronger model, and Haiku is reserved for the pipeline's extraction, translation and tagging.
- **Numbers in answers are validated** against the cited chunks, not just citations.
- **Share and proxy changes delete nothing.** Access is checked on every request.

## 15. Open questions

1. **Staff text retention period.** Is 90 days right, and who holds the `AI_SAFETY_REVIEWER` permission?
2. **India-hosted embeddings.** Which model or provider? Its dimension must be 1024, or real-data facilities need a separate column.
3. **Sensitive-category mapping.** The clinical advisor's list, and its codes (ICD-10 ranges, tests, note types).
4. **Same-organization consent.** Is the existing `InteropConsent` with recipient ORGANIZATION the right vehicle, or does 4c's sharing model replace it?
5. **Proxies of minors.** At 18 the member chooses whether parents keep access (feature D). Should the AI index of a newly adult member be re-consented?
