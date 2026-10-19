# Retrieval-augmented answers over the patient record: design (Week 4b)

- **Status:** Revision 3, **built in Week 4b** (2026-10-18; §16 records what the code does where it differs). Real data stays off.
- **Revision 3 (2026-10-17):**
  - person-owned sources (`docs/PERSON_IDENTITY_DESIGN.md`, Phase 0);
  - product decisions 2–11 applied (§13.2): the reviewer roles, deferred India-hosted embeddings with a re-embed job instead of a fixed vector column, same-organization consent through the existing consent model, guardian consents lapsing at 18, items pending the clinical advisor.
- **Revision 2 (2026-10-17):**
  - aligned to `docs/PRODUCT_SPEC.md` feature E;
  - the open questions of revision 1 answered by product direction (§13);
  - the patient-provided records of the document pipeline (`docs/DOCUMENT_PIPELINE_DESIGN.md`) added as an index source.
- **Branch:** `foundation/w4-intelligence`
- **Builds on:**
  - **Person identity (Phase 0):** uploads, patient-provided facts and patient-given consents (including `AI_ASSISTANCE`) belong to the `Person`;
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
13. Product decisions
14. Decisions taken for you
15. Open questions
16. As built (Week 4b)

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
| `PATIENT_PROVIDED` | Confirmed by the person (or a proxy) from an upload; **person-owned** | `PatientProvidedRecord` (pipeline §2.6) and patient-provided allergies, linked to the original page; labelled "handwritten" too when the source page was |
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
| `ownerType` | `FACILITY_PATIENT` (a facility record) or `PERSON` (a person-owned source). |
| `organizationId?`, `facilityId?`, `patientId?` | Set for `FACILITY_PATIENT`: the source record's tenant, never the caller's. `patientId` is canonical; merges are handled at query time with `patientIds`. |
| `personId?` | Set for `PERSON` sources. Also set on `FACILITY_PATIENT` documents whose patient has an ACTIVE link, so a person's whole record can be gathered for the owner. Unlinking clears it (§5.6). |
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
- Indexed on `(facilityId, patientId, status)` and `(personId, status)`.
- CHECKs:
  - `FACILITY_PATIENT` requires `facilityId` and `patientId`;
  - `PERSON` requires `personId` and no `facilityId`;
  - `origin = PATIENT_PROVIDED` requires `ownerType = PERSON`.
- `PERSON` documents join the PERSON tenancy segment (Person design §8.1).

### 3.2 `RagChunk`: the unit retrieval returns

| Field | Notes |
|---|---|
| `id`, `documentId` (cascade), `chunkNo` | `(documentId, chunkNo)` is unique. |
| `ownerType`, `facilityId`, `patientId`, `personId`, `category`, `sensitiveCategory`, `origin`, `audience`, `status` | Copied from the document so every filter runs on the chunk row, before ranking. |
| `text` | The chunk in its original language (protected as PHI). |
| `translatedText?`, `translationLanguage?` | For patient-facing modes, filled when the original isn't in the patient's language. Taken from the pipeline's translation rows. |
| `heading?`, `tokenCount` | |
| `tsv` | A generated column: `to_tsvector('simple', …)` over the original text and any translation. |

Indexes:
- GIN on `tsv`;
- B-tree on `(facilityId, patientId, status, audience)` and `(personId, status, audience)`.

### 3.2a `RagEmbedding`: one vector per chunk per embedding model (decision 8)

Changing the embedding provider or its dimension must be a background job, not a schema migration. So the vector is not a fixed-dimension column on the chunk:

| Field | Notes |
|---|---|
| `chunkId` (cascade), `embeddingModel`, `embeddingVersion` | Unique together. `embeddingVersion` changes when the same model is re-run with different input preparation (the context prefix, chunking). |
| `dims` | |
| `embedding` | An untyped pgvector `vector`. A CHECK enforces `vector_dims(embedding) = dims`. |
| `ownerType`, `facilityId`, `patientId`, `personId`, `status` | Copied from the chunk, for filtering. |
| `createdAt` | |

How it is used:
- **Queries** read only the active model (`ai.embedding.active` = `{model, version}`) and compare with exact cosine distance after the B-tree filters. Every query is about one patient, so this is a scan over that patient's chunks: hundreds to a few thousand rows.
- **No ANN index is required**, so a new model or dimension needs no DDL. An HNSW index can be added later by migration if a patient's record grows past what the exact scan serves within budget. The gate measures that budget (§12 step 3).
- **Every chunk records** `embeddingModel` and `embeddingVersion` (decision 8), and so does every `AiInteraction` (§3.3).
- **Re-embed job:** §5.8.

### 3.3 `AiInteraction`: one request, for audit, safety review and evaluation

| Field | Notes |
|---|---|
| `id`, `organizationId`, `facilityId`, `userId`, `role` | |
| `patientId?`, `personId?`, `proxyGrantId?`, `shareId?`, `consentId?` | The subject and the access path used. |
| `mode`, `language`, `model` | The generation model actually used (§6.1). |
| `embeddingModel`, `embeddingVersion` | The embedding the query was ranked with. |
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

Index rows are deleted in the cases in the table below. A person-owned source belongs to the Person (Person design §7), so a facility unlink never deletes the person's own documents.

| Trigger | What goes |
|---|---|
| An amended or corrected source | The previous version's chunks, in the same transaction that inserts the new ones. The old document row stays `SUPERSEDED`, with no text. |
| Source voided, entered in error, or a patient-provided record withdrawn | That document goes to `WITHDRAWN` and its chunks are deleted. |
| AI consent withdrawn (§11.3) | Every document and chunk for the patient. |
| An erasure request completes | Everything for the patient, including any `AiInteraction` text. |
| A facility unlink (`PersonPatientUnlinked`) | Nothing is deleted. The facility's documents lose their `personId` and the person's documents become unreachable from that facility, both in the same consumer step. A `WRONG_PERSON` unlink also withdraws conflicts derived from that facility. |
| An embedding model change | Re-embed, then drop the old rows or column. |

A share expiring, a proxy permission removed, or family access revoked deletes nothing. Access is checked on every request, so the next request is refused.

### 4.3 Question and answer text

- **Staff modes:** the text is kept for safety review.
  - It is encrypted at the application level with AES-256-GCM, under a key from the environment and its KMS.
  - `keyVersion` allows key rotation.
  - It is kept for `ai.staff_text_retention_days` (default **90**), then purged by the runner's sweep.
  - Decryption needs the `ai:interaction:text:read` permission. It is held only by the **clinical-advisor** role and a **platform safety-officer** role (decision 7), both new and platform-level.
  - Every read is audited (who, which interaction, why: a closed reason code plus a ticket reference) and appears in a monthly review report.
  - Reviewers read staff text, and patient text only where the patient's `AI_TEXT_RETENTION` opt-in explicitly included safety review (scope `SAFETY_REVIEW`). Text kept under an opt-in without that scope is never decryptable by reviewers.
- **Patient and proxy modes:** no text is kept unless the person opts in. The opt-in is its own consent purpose, `AI_TEXT_RETENTION`, with its own DPDP notice. With the opt-in, the same encryption and retention apply. Without it, only metadata is kept.
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
| `PersonDocumentUploaded` | Title, type and date only, until its facts are confirmed (a PERSON document). |
| `PersonPatientLinked`, `PersonPatientUnlinked`, `PersonPatientLinkSuperseded`, `PersonMerged` (Person design §9) | Set, clear or re-point `personId` on facility documents; re-point person documents on a merge. |
| `ConsentGranted` / `ConsentRevoked` for the upload-sharing choice (Person design §8.3) | Nothing indexed or deleted. The choice is checked at query time; the event is recorded for the audit trail. |
| `ConsentRevoked` | Removal, when the revoked consent is the AI consent (§11.3). |
| `ConsentLapsed` (new; on turning 18) | AI over the member's record stops until they confirm (§11.3). |
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

### 5.8 Re-embedding (a background job, decision 8) and failures

`npm run rag:reembed -- --model <id> --version <n>`, also runnable from the runner:
1. Writes `RagEmbedding` rows for the new `{model, version}` alongside the active ones. It works per patient or person in batches, with a resumable cursor, rate-limited, and idempotent on `(chunkId, model, version)`.
2. Reports coverage. When 100% of `ACTIVE` chunks have the new embedding, an operator switches `ai.embedding.active` (a config change, audited).
3. After a grace period, deletes the old model's rows.

New chunks are embedded with every model whose re-embed job is running, so coverage converges. No step needs a schema migration.

Failures:
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
  readonly dimensions: number;
  embed(texts: string[], inputType: "document" | "query"): Promise<number[][]>;
  rerank?(query: string, documents: string[]): Promise<{ index: number; score: number }[]>;
}
```

- **Voyage:** a multilingual model at 1024 dimensions, plus its reranker. Used for synthetic data.
- **India-hosted: deferred** (decision 8). The adapter keeps the slot. Any dimension works, because of `RagEmbedding` (§3.2a); switching is a re-embed job (§5.8).
  - Before real data: check the DPDP cross-border transfer rules for each processor.
  - If Voyage isn't allowed for real data, an India-hosted provider is chosen then.
- **Mock:** deterministic and offline.
  - Feature hashing of word unigrams and bigrams into 1024 dimensions, L2-normalized.
  - Its reranker is BM25.
  - Selected whenever no provider key is set.

## 7. Retrieval

### 7.1 Filters first, in SQL

**One access resolver (decided 2026-10-18).** The AI index has no access
rules of its own. Every retrieval asks the same resolver every other read uses
(`src/lib/person/access.ts`: `personAccess()` and the staff document
visibility), so the AI can never see more than the same actor could open in
the app:
- the person's sharing choice;
- the active care relationship, with the facility's OPD and IPD windows
  (`identity.care_window_{opd,ipd}_days`, capped at 90);
- links, unlinks and account closure.

The SQL filters below are that resolver's decision expressed as a
pre-filter. The leak gate checks that retrieval and the resolver agree, case
by case.

Every query starts from a CTE built only from server-side values:

1. **Access path:**
   - **Treating facility:** the caller's facility, with the patient registered there.
   - **Another facility in the same organization:** only with the patient's consent, an `InteropConsent` with recipient type `ORGANIZATION` (decision 9; 4c extends it).
   - **Share:** the share's facility or doctor, the categories it covers, and its date range.
   - **Proxy:** the proxy's granted categories and the `USE_AI` permission.
   - **Patient:** their own scope, meaning their Person (all their person-owned documents) plus their ACTIVE links' facility documents.
   - **Person-owned chunks for facility staff:** only with the person's upload-sharing opt-in (Person design §8.3) and an active care relationship, or through a share that includes `UPLOADS`. A nurse also needs the assignment. Without these, a `PERSON` chunk is never a candidate for staff.
2. **Subject:** `patientId = ANY(scope.patientIds)` for facility chunks, `personId = scope.personId` for person chunks (merge-aware on both).
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
8. **AI consent:** `AI_ASSISTANCE` (a person-given consent) must be active, and not lapsed, when the data is real (§11).

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
- Person B's uploads and patient-provided facts, asked for by: a treating facility without B's opt-in; a facility outside the care window; a facility after B unlinked; Person A's account;
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
| `Facility.dataClassification`, `Person.dataClassification` | `REAL` for every new facility and Person; `SYNTHETIC` only for the seeded demo ones (set by migration) | A query over real data is refused while the switch is off. |
| `ai.enabled` (per facility) | `false` | An admin turns the assistant on per facility. |

With the switch off, a real facility's events are still delivered and recorded as skipped. Turning it on later means a backfill, not a gap.

**The switch stays off until the clinical advisor signs off** (decision 11). The advisor is not yet named. Every item that waits for them is marked **"pending clinical advisor"**:
- the sensitive-category list (§3.1, §5.3);
- the evaluation answers (§10.1);
- each mode's prompt and refusal rules (§9.9).

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

Both are **person-given** consents (Person design §7) on `InteropConsent` with `subjectPersonId`.

Rules:
- For a minor, the guardian consents.
- **On turning 18 (decision 10),** every guardian-given consent, including `AI_ASSISTANCE`, `AI_TEXT_RETENTION`, `DOCUMENT_PROCESSING` and parental access, lapses to "needs your confirmation". It emits `ConsentLapsed`.
  - While lapsed, the consent counts as not granted: no AI over the record, no new indexing, and no text retention.
  - The index is kept for 90 days (`ai.lapsed_consent_index_days`). If the member confirms, nothing needs rebuilding.
  - If they decline or don't confirm in time, the index is deleted as for a withdrawal.
- A proxy grants `AI_ASSISTANCE` only if their permissions include consent.
- Withdrawing `AI_ASSISTANCE` emits `ConsentRevoked`, which removes the patient's index (§5.6).

## 12. Order of wiring, each step with its gate

Each step is its own commit. `verify:all`, `npm test`, lint and build stay green after each.
- **Prerequisite:** Phase 0 (Person identity) is complete.
- **Shared steps:** steps 1–2 are shared with the document pipeline, and whichever phase comes first builds them.

| # | Step | Gate |
|---|---|---|
| 1 | The real-data switch: `Facility.dataClassification`, `ai.enabled`, the `AI_ASSISTANCE` and `AI_TEXT_RETENTION` consent purposes | Unit tests and `verify-postgres-ai-switch`: a REAL facility is refused everywhere while the switch is off. |
| 2 | Model config per mode, and the provider boundary extended (`answerFromRecord`) with the mock | Unit tests: the model is chosen from config; no real provider without a key. |
| 3 | Models and migration: `RagDocument` (owner CHECKs), `RagChunk` (tsvector, GIN), `RagEmbedding` (untyped vector with the dimension CHECK), `AiInteraction` with encrypted text fields; the reviewer roles and permission | Migration on a fresh database; drift check; constraint tests; tenancy sweep with the PERSON segment; a **latency gate**: exact-scan retrieval over a 20,000-chunk patient at **p95 < 150 ms** (accepted 2026-10-17); a failure blocks the step. |
| 4 | Embeddings adapter (Voyage, the mock, the deferred India-hosted slot) and the re-embed job (§5.8) | Unit tests: determinism, similar texts closer than unrelated ones. Gate: a re-embed to a mock model of another dimension reaches 100% coverage; the switch changes rankings; no schema change. |
| 5 | Renderers, categories and the sensitivity mapping (the placeholder list), chunker | Golden-file tests per source type; every source type maps to a category. |
| 6 | The `rag-indexer` (§5.1) and backfill; `EXPECTED_CONSUMERS` gains it; the catalogue doc regenerates | `verify-postgres-rag-indexer`: one document per version; replay creates nothing; supersede on amendment; consent withdrawal removes everything; REAL facility skipped; backfill matches consumption. The core journey covers the indexer. |
| 7 | Retrieval: filters, hybrid ranking, origin ranking, per-mode thresholds | `verify-postgres-rag-leaks` (§10.3): zero leaks. Unit tests for fusion and thresholds. |
| 8 | `POST /api/ai/ask`: modes, access paths, safety rules, number validator, streaming, rate limits, encrypted text retention | `verify-postgres-ai-ask` (mock model): each mode allowed or refused per role and access path; a nurse's unassigned patient refused; patient diagnosis and dosing asks refused; an invalid citation or number stops the answer; label present; `NO_RECORD` below threshold; 429 at the limit; no text kept without opt-in; nothing written to the record. |
| 9 | Evaluation set and scorer | CI: the mock retrieval target. Manually, with real providers on synthetic data: at least 90%, recorded in the PR. |
| 10 | UI: the doctor visit brief and chart Q&A, the nurse panel, the patient explain/timeline/pre-visit screens, the proxy switcher | UI tests and a smoke test per mode against the mock. |

## 13. Product decisions

### 13.1 Revision 2: revision 1's open questions (2026-10-17)

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

### 13.2 Revision 3 decisions (product direction, 2026-10-17)

| # | Decision | Where |
|---|---|---|
| 1 | Person identity first; patient-provided sources, uploads and patient-given consents belong to the Person | §2, §3.1, §5.1, §7.1, §11.3 |
| 3 | Treating-facility clinicians see patient-provided facts only with the person's opt-in | §7.1 |
| 4 | Handwritten facts carry their label | §2 |
| 7 | 90 days for staff text; decryption only for the clinical-advisor and platform safety-officer roles; every read audited | §4.3 |
| 8 | India-hosted embeddings deferred; `embeddingModel` and version on every chunk; re-embedding is a background job, not a schema migration | §3.2a, §5.8, §6.2 |
| 9 | Same-organization access reuses the existing consent model with an organization recipient; 4c extends it | §7.1 |
| 10 | At 18, guardian-given consents lapse to "needs your confirmation" | §11.3 |
| 11 | Clinical advisor not yet named; blocked items marked "pending clinical advisor"; the real-data switch stays off until sign-off | §11.1 |

## 14. Decisions taken for you

All take the more conservative option and can be reversed.

- **No ANN index at first.** Decision 8 says a provider change must not need a migration, and a fixed-dimension column with an HNSW index would. Retrieval is an exact scan over one patient's or person's embeddings. HNSW is added by migration only if the latency gate shows it is needed.
- **A lapsed consent counts as not granted.** The index is kept 90 days so confirming needs no rebuild, then deleted.
- **A facility unlink deletes nothing.** It only detaches: the facility's documents lose the `personId`, and the person's documents stop being reachable from that facility.

- **Free-form patient Q&A is dropped.** Revision 1 had `PATIENT_QA`. Feature E lists explain-my-report, the timeline and pre-visit questions, so open patient questions are allowed only as follow-ups inside `EXPLAIN_REPORT`, about that report.
- **The nurse handoff is kept** from the Week 4 brief, limited to assigned patients like chart Q&A.
- **Doctor patient-provided facts:** a doctor sees patient-provided facts only when the share includes `UPLOADS`, and the fact's own category too.
- **Unconfirmed extracted facts** are never indexed. Only `EXPLAIN_REPORT` reads the one document being explained, labelled as unconfirmed.
- **Staff text retention defaults to 90 days.** Decryption needs a dedicated permission and is audited.
- **Sonnet 5.5 for all patient-facing modes,** not Haiku. Patient explanations need the stronger model, and Haiku is reserved for the pipeline's extraction, translation and tagging.
- **Numbers in answers are validated** against the cited chunks, not just citations.
- **Share and proxy changes delete nothing.** Access is checked on every request.

## 15. Open questions

Revision 2's questions are settled: decisions 7, 8, 9 and 10, and decision 5 of revision 2 (the sensitive list is pending the clinical advisor). What remains:

None open. Answered 2026-10-17:
- the lapse window is 90 days;
- reviewers read staff text, and patient text only with an explicit safety-review opt-in (§4.3);
- the latency budget is p95 < 150 ms at 20,000 chunks, enforced by a gate (§12).

## 16. As built (Week 4b, 2026-10-18)

What the code does where it differs from, or adds to, the sections above. Each item takes the more conservative option.

### 16.1 Step 2: model configuration and the answer boundary

- **The answer boundary is its own provider family** (`src/lib/ai/record`: `RecordAnswerProvider.answerFromRecord`), next to the document providers, rather than a fifth method on the Scholar/assistant `AIProvider`. Same reasons as the pipeline's: its own permit (`AiPermit`, issued only by the real-data gate), its own provider switch, and no way for a Scholar code path to reach patient data.
- **Claude only with both a key and `RECORD_AI_PROVIDER=claude`**; otherwise the deterministic mock. **The mock refuses a permit for real data**, so a real patient's record is only ever answered by the configured model, and a provider failure is a 503 (`RecordAiUnavailableError`), never the mock.
- **Model ids per mode** (`ai.model.<mode>`) are read like the pipeline's (`AI_MODEL_<KEY>`, Claude ids only), not through the config registry, whose scopes are organization, facility and department; a model is a platform choice.
- **The mock is extractive:** every factual sentence is a source line copied verbatim and cited; patient-facing answers open with a fixed line from a phrasebook in the eleven app languages (`src/lib/rag/phrases.ts`, no numbers, pending clinical advisor).
- **Config keys:** `ai.enabled` (off by default), `ai.threshold.<mode>` (thousandths of the best rerank score; patient-mode defaults above every staff default), `ai.staff_text_retention_days` (90, at most 90), `ai.daily_request_budget`, `ai.lapsed_consent_index_days` (90).

### 16.2 Step 3: models, migration and the latency gate

- **Vectors are half precision (`halfvec`), stored on the heap row.** Still untyped (any dimension, a CHECK on `vector_dims`), still compared by exact cosine distance with no approximate index; only the stored precision is 16-bit. Found by the latency gate: a 1024-dimension `vector` is 4 KB, so Postgres moved it to TOAST and the scan spent ~185 ms re-reading it; inline full-precision vectors filled a page each (195 MB for 25,000 rows, ~85 ms). Half precision inline is 65 MB and ~23 ms. The migration sets `STORAGE MAIN` and `toast_tuple_target = 8160`, so vectors of up to ~4,000 dimensions stay inline.
- **The candidate query is planned for its own parameters every time** (`SET LOCAL plan_cache_mode = force_custom_plan`, in its own transaction). After five runs of the same prepared statement Postgres switched to a generic plan about 100× slower (10 ms → 1.1 s). Also found by the latency gate.
- **The vector search filters on the embedding row alone.** `RagEmbedding` carries every filter column of its chunk (categories, sensitive category, audience, origin, `recordedAt`, `sourceId`, besides the owner and status the design copied), **filled by a trigger from the chunk on insert** — never by the app, so the copy can't disagree — and kept in step when a chunk's Person changes. Found on CI: joining each candidate embedding to its chunk cost ~20,000 index lookups per query, and the whole retrieval missed the budget on the slower runner (p95 156.9 ms).
- **Gate result:** 20,000 chunks for one patient (5,000 for another beside them): candidate search (exact cosine top 40 and keyword top 40, every access filter first) at **p95 51.5 ms** locally (88.9 ms before the change above), the whole retrieval **p95 59.5 ms**, against the 150 ms budget; not one candidate of the other patient.
- **A document has `categories` (an array), not one `category`:** a patient-provided lab value is both `UPLOADS` and `LABS` (§5.3), and a chunk is a candidate only if every one of its categories is allowed (`categories <@ allowed`).
- **Added:** `ALLERGY_STATUS` as a source type (the record-level allergy status, 4a follow-up b); `title`, `handwritten` and the chunk's `context` line, `recordedAt`, `sourceType`/`sourceId` on chunks (for labels, recency and citations without a join); `RagEmbeddingSpace` (the embedding models and versions, exactly one ACTIVE by a partial unique index, the offline mock to start), which is where `ai.embedding.active` lives (§5.8) — a platform setting, so not in the organization/facility config registry; `AiTextReadLog` (every reviewer read: who, which interaction, a closed reason, a ticket).
- **Mixed owners:** `RagDocument`, `RagChunk`, `RagEmbedding` and `AiInteraction` are owned row by row by a facility record or by a Person (`MIXED_OWNER_MODELS`); a Person merge re-points them; the tenancy sweep treats their PERSON rows like the person-scoped models.
- **Reviewer roles:** `CLINICAL_ADVISOR` and `SAFETY_OFFICER` (platform-level) hold only `ai:interaction:review` and `ai:interaction:text:read`; `ai:record:ask` (the staff modes) is for doctors and nurses; `ai:embedding:manage` for the platform admin.
- **Retained text is at most 90 days by a CHECK**, and complete or absent (ciphertext, key version, scope and expiry together).

### 16.3 Step 4: embeddings and the re-embed job

- **The provider is the embedding space's** (`RagEmbeddingSpace.provider`), never a request's: `mock` (feature hashing, the model name carries the dimension: `mock-hash-1024`), `voyage` (`voyage-multilingual-2`, 1024, with `rerank-2`; needs `VOYAGE_API_KEY`), `india-hosted` (the slot exists; it refuses, deferred).
- **Every embedding or rerank call needs an AI permit** from `aiAssistancePermit` (`src/lib/ai/realData.ts`): an explicit `AI_ASSISTANCE` decline refuses even synthetic data; synthetic data needs nothing more; real data needs the switch on and the Person's grant (a facility record's Person is its ACTIVE link's; a record with no Person can't consent and is refused).
- **Voyage refuses a permit for real data** outright, until the cross-border check for that processor is done and the guard is changed on purpose.
- **The mock reranker's score is BM25 squashed to 0..1** (`1 − e^(−bm25/2)`), so the per-mode thresholds read the same scale as Voyage's relevance scores; they are calibrated on the evaluation (§10).
- **The re-embed** (`npm run rag:reembed`, and one batch per building space each runner tick) refuses a provider that can't embed now before writing anything; the switch (`activateEmbeddingSpace`) needs 100% coverage, re-checked inside its transaction, retires the old space in the same transaction, and emits `RagEmbeddingSpaceChanged` (platform, new) and an audit event. A retired space's embeddings are deleted after a 7-day grace period by the runner.
- **An owner the AI may not use is removed from the index, not skipped** (`removeOwnerIndex`, a hard delete): found by the gate in a full run, where a REAL Person's rows (a fixture) were skipped on every batch and blocked coverage for good. The index never holds data the gate refuses.

### 16.4 Step 5: renderers, categories, sensitivity and chunking

- **Renderers are pure** (`src/lib/rag/render.ts`): the indexer loads a source through the service layer and hands a plain object over; golden tests per source type.
- **Audience:** clinicians' notes are `STAFF_ONLY` (patient-facing modes never read them); a clinical document follows its own access policy; released results, diagnoses, problems, allergies, the allergy status, vitals, referrals, discharge summaries and the patient's own entries are `PATIENT_VISIBLE`.
- **Categories:** generated and clinical documents by their type (prescription, discharge, lab, imaging, referral, else clinical notes); a patient-provided entry is `UPLOADS` plus its fact's own category; added `DIAGNOSES`, `ALLERGIES`, `VITALS` and `REFERRALS` for the record's structured kinds.
- **Sensitive categories (placeholder, pending clinical advisor):** by ICD-10 range (F10–F19 substance use, other F mental health, B20–B24 and Z21 HIV, A50–A64 sexual health, O and Z30–Z39 reproductive) and by words in diagnoses, test names, note types and text; it errs towards marking.
- **Chunking:** tokens are estimated (a quarter of the characters, at least one per word); a sentence longer than the 512 maximum stays whole as its own chunk (the design says never split a sentence); one document per lab result row (each row is one analyte here) and one per encounter-day of vitals.

### 16.5 Step 6: the rag-indexer and backfill

- **Version per source:** a source changed in place (a diagnosis resolved, an allergy inactivated, a referral moving on) has no version number of its own, so the indexer gives its document the next version whenever the rendered content's hash changes; an amendment that is a new row (a note, a lab or imaging result) names its predecessor and supersedes it. The allergy status uses its history's sequence.
- **Vitals** are one document per encounter-day (`<encounterId>:<yyyy-mm-dd>`), re-rendered as readings arrive; other observation kinds (ICU, ED reassessment, intake/output) are not indexed yet.
- **Never indexed:** a patient-provided allergy bridged to a facility record (the Person's own entry already is), a patient's own pre-Phase-0 upload on a facility record, ID proofs, restricted documents, drafts.
- **`DocumentTranslated` adds nothing:** translations exist only for a document's OCR text, which is never indexed (only confirmed facts are). Patient-facing answers in other languages are written by the model from the original values (§9.4).
- **Removals:** AI consent declined removes the Person's own documents and their linked records' (and later events are skipped); granted again, or an account reopened, re-indexes through the indexer's own function; an account closed or purged removes the Person's own documents; **a family member's access revoked purges the retained text of that member's AI questions** (metadata stays) — the index itself is per patient, so nothing else changes and access is checked live.
- **Consents lapse at 18** (`PersonConsent.status = LAPSED`, `PersonConsentLapsed`, new): the runner lapses every choice decided before the 18th birthday; a lapsed AI consent refuses the AI like a decline (even on synthetic data) and its index is removed after 90 days unless the person chooses again. A re-embed in the window removes a lapsed owner's index too (rebuilt on confirmation): a provider switch isn't held up for 90 days.
- **The backfill** walks each source type by id with a cursor per (facility, type) in `RagBackfillCursor`; Person-owned sources are re-indexed per Person (consent re-grant, reopening).
- Gate: `verify-postgres-rag-indexer` (33 checks); the core journey checks the journey's result, confirmed entries and discharge summary are indexed.

### 16.6 Step 7: retrieval and the leak gate

- **The access paths** (`src/lib/rag/access.ts`), all from server-side values:
  - **TREATING:** a doctor at the patient's facility with an **active care relationship** (the resolver's OPD/IPD windows) — stricter than "registered there" (§7.1), the same rule person-level data already uses. Every category, sensitive included (the chart permission decides, §7.1.5). The Person's uploads and confirmed facts only with their opt-in (`personAccess`).
  - **NURSE_ASSIGNED:** a nurse with an open `NursingAssignment` for the patient (start in the past, end empty or ahead); chart Q&A and the handoff only.
  - **SHARE:** the code share that exists today, `PatientAccessSession` (ACTIVE, redeemed by this doctor, not expired). It has no category or date-range choice yet (4c), so it never includes `UPLOADS` and never a sensitive category; the date-range limit of §10.3 is tested on the timeline's period until 4c's share model carries one.
  - **ORG_CONSENT:** a doctor at another facility of the same organization, with an `InteropConsent` to that organization (GRANTED/ACTIVE, not revoked or expired); its scopes map to categories; never sensitive.
  - **OWN:** the patient's OWNER login: every ACTIVE link's record (`PATIENT_VISIBLE` entries) and their own uploads and facts.
  - **Proxies are refused** (404): the `USE_AI` permission arrives with households (5b).
  - Staff use needs `ai.enabled` at the caller's facility; the seed turns it on at the two SYNTHETIC demo facilities only.
- **Ranking** as §7.2: fusion `1/(60+rank)`; rerank (the space's reranker) of the top 30; "latest/last/current" adds up to 0.15 for the newest; a patient-provided chunk gives 0.02 to a verified one; ties by recency. The brief, the handoff and the timeline also get the latest vitals day and the allergy, allergy-status, problem and diagnosis entries in scope; the timeline is ordered oldest first.
- **"No record found":** for a question, when the best rerank score is under the mode's threshold **and** no keyword match covered every content word of the question; for the other modes, when nothing at all is in scope. A patient mode's threshold is raised to the highest staff threshold if configured lower.
- **Live facts** (§7.4) are read only from the records the path allows, and only for categories it allows (`PRESCRIPTIONS`, `ALLERGIES`); a medicine whose name maps to a sensitive category is left out where sensitive categories aren't opted in; a nurse also gets doses due or missed within 12 hours either side; patient-provided bridged allergies only where the opt-in applies.
- **Gate:** `verify-postgres-rag-leaks`, 28 checks, zero leaks, with a positive control per canary. The latency gate now also times the whole retrieval for a question (p95 59.5 ms locally after §16.2's change).
- **Bug fixed (pre-existing, found by the tenancy sweep):** `GET /api/hospital/enterprise/configuration` listed every override of the organization, so a facility admin saw a sister facility's facility-level values. No facility-level override existed until this step seeded `ai.enabled`; facility and department rows are now returned only to actors who can access that facility.

### 16.7 Step 8: `POST /api/ai/ask`

- **Order:** rate limits → access (403/404) → the patient safety rules (urgent symptom: the emergency line only; diagnosis or treatment question: "please ask your care team"), before anything is retrieved → retrieval ("no record" without asking the model) → the provider, with the record's identifiers masked (`[redacted]`: names, UHIDs, phones, contacts, ABHA- and mobile-shaped numbers) → validation → labels → the interaction log.
- **Validation:** a FACT must cite only retrieved sources, and every number in it must occur in the original text or context line of a source it cites (normalized: thousands separators and leading zeros); a GUIDANCE line cites nothing and states no number (112 excepted). Staff: the answer stops at the first failing sentence (`CITATION_INVALID`; the lines before it were streamed). Patients: withheld whole.
- **Labels per line:** `verified` / `patient-provided` from the cited sources, `handwritten` where a cited source is, `not yet confirmed by you` for the patient's own upload explained before review (read from its OCR text directly, never the index), and `translated` whenever the answer is in a language other than the sources' (English) or uses a translation.
- **Streaming:** `meta` is sent first (the interaction id is minted before the answer); errors before the stream opens are plain status codes, after it a closing `done` with `outcome: ERROR`.
- **Rate limits** count the interaction log (so they hold across instances); the two-concurrent cap is per process. A refused request is logged as `RATE_LIMITED` (metadata only).
- **Text:** encrypted with `AI_TEXT_KEY_<version>` (`AI_TEXT_KEY_VERSION`); **with no key configured, nothing is kept** (metadata only). Patient text is kept for 90 days under the opt-in. Reviewer routes: `GET /api/ai/interactions` (metadata), `GET /api/ai/interactions/report?month=YYYY-MM`, `POST /api/ai/interactions/:id/text` (`reasonCode`, `ticketRef`).
- **Bug fixed:** the mock reranker scored a question's function words ("the", "is"), so "What is the blood group?" matched "see the allergy list" above the threshold; query stopwords are dropped before BM25.
- **Gates:** `verify-postgres-ai-ask` (39 checks, service and HTTP); the leak gate now runs every allowed case through the whole request too (the prompt's sources, the answer, the citations, the interaction's chunks and stored answer).

### 16.8 Step 9: the evaluation

- **The set** (`eval/rag/questions.json`, "pending clinical advisor sign-off"): 4 visit briefs (one through a visit code, which must leave out the patient's uploads), 8 chart Q&A (latest vs earlier, the amended value, a verified-vs-patient-provided disagreement), 4 nurse (missed and due doses, the allergy, the latest abnormal vital), 5 explain-my-report (two in Hindi and Marathi, one uploaded report, one diagnosis ask that must be refused), 3 timeline/pre-visit, 6 not in the record (three in patient modes). The synthetic patient is built through the services and the indexer (`scripts/lib/ragEvalFixture.ts`).
- **Scoring** as §10.2 (`src/lib/rag/evalScore.ts`); the gate `verify-postgres-rag-eval` (CI, mocks) requires ≥ 90% correct with valid citations **and** the expected source retrieved for ≥ 90%. `npm run eval:rag` runs the same on the local verify database; `npm run eval:rag:real` is the manual real run (Claude answers; Voyage if its key is set).
- **Mock result: 30/30** correct with valid citations, 30/30 expected source retrieved. With the extractive mock this checks retrieval, access, validation and labels, not answer quality.
- **Found and fixed on the way (first run 26/30):** imaging modality codes weren't expanded ("XRAY" never matched "X-ray"; §5.3 says codes are expanded); the keyword side had no stemming ("allergic" missed "Allergy": a small English suffix stripper now makes stemmed words prefix matches); live facts didn't count towards "no record" (a question about allergies answered by the live allergy list was refused); the brief and the handoff didn't carry recent results (the newest result per test is now always in them); the mock reranker didn't weigh how much of the question a passage covers.
- **Thresholds calibrated** on this set with the offline reranker: staff modes 0.50, patient modes 0.55 (every correctly answered question scored ≥ 0.617; the one false match 0.424). They must be recalibrated on the real reranker's scale (Voyage) before real data; the real run reports the values in force.
- **Real run (2026-10-18): ready, not run** — the Anthropic key in `.env.local` is refused for insufficient credit, and there is no Voyage key.

### 16.9 Step 10: the screens

- **One panel, three places** (`src/components/ai/RecordAi.tsx`): the AI-generated label, each line with its citation numbers and labels, the cited entries with links into the record (staff), outcomes in plain words; staff answers stream line by line, patient answers arrive whole.
  - **Hospital OS AI Cockpit:** for doctors and nurses, "Ask about a patient's record", choosing among their current patients (active encounters).
  - **The chart** (`/hospital-os/doctor/patients/:id`): the modes the role may use; the doctor's next appointment with the patient is the visit brief's reason (`GET /api/ai/me`).
  - **The patient portal:** "Explain" on every released report and upload (`/patient/reports`), the health timeline and questions for the next visit (`/patient/records`), in the patient's language (eleven to choose from).
- **Proxy switcher:** not built — proxies are refused until households (5b) add `USE_AI`.
- **Tests:** the stream parser (unit), every mode over HTTP and through the service (`verify-postgres-ai-ask`), and the core journey now asks the AI about its patient (answered, the critical troponin cited as verified, logged, no event, nothing written). The screens were checked by the type checker, lint and the production build, not by a browser run.

### 16.10 Week 4c: the SHARE path uses the share's scope (2026-10-19)

The 4b stand-in is replaced. The SHARE path now resolves the share through `src/lib/sharing/resolve.ts` (a code session or an approved request; docs/CONSENT_SHARING_DESIGN.md §8):
- **categories:** the share's, with ALLERGIES;
- **sensitive opt-ins:** the share's;
- **period:** the share's, intersected with the request's;
- **uploads:** a PERSON segment (patient-provided origin) only with UPLOADS.

**Live facts follow the share:** medicines only with PRESCRIPTIONS and within the period; patient-provided allergies only with UPLOADS. Sensitive allergies are filtered on every path.

**The person's access log:** a staff request that reaches the person's data writes a `RECORD_ACCESSED` entry (`surface: AI_ASK`) with the way in.

**Leak gate:** section 13 (real codes; one canary per limit, each with a control).
