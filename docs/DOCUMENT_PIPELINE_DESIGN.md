# Document pipeline: design (Week 4a)

- **Status:** Design for review. No code yet.
- **Date:** 2026-10-17
- **Branch:** `foundation/w4-intelligence`
- **Spec:** `docs/PRODUCT_SPEC.md` feature A, principles 4 (verified vs patient-provided), 5 (originals never replaced) and 8 (AI assists, never decides).
- **Builds on:**
  - patient uploads (`uploadPatientDocument` → `ClinicalDocument` in the private `patient-uploads` bucket; PDF, JPEG, PNG or WebP, content-checked, at most 15 MB; emits `PatientDocumentUploaded`);
  - the storage adapter;
  - the workflow spine (outbox, ordered consumers, retries, dead letters);
  - the AI provider boundary;
  - the consent service and patient access scope.
- **Feeds:** `docs/RAG_DESIGN.md` (confirmed facts and translations are index sources).

## Contents

1. Flow
2. Data model
3. How a confirmed fact becomes a record entry
4. Steps as consumers, and their events
5. Exact-copy rules
6. Adapters
7. Confidence
8. Conflicts with verified records
9. Patient review API and proxy permissions
10. Evaluation
11. Privacy
12. Order of wiring, each step with its gate
13. Decisions taken for you
14. Open questions

---

## 1. Flow

```
upload (existing) ─► PatientDocumentUploaded
   │
   ▼  [page-split]      DocumentPagesPrepared        pages rendered to images; the original untouched
   ▼  [ocr]             DocumentTextExtracted        per page: text, language, confidence
   ▼  [translate]       DocumentTranslated           per page → the patient's app language (skipped if same)
   ▼  [extract]         DocumentFactsExtracted       facts with confidence and page/region references
   ▼  (patient review)  ExtractedFactReviewed        CONFIRMED / CORRECTED / REJECTED, one per fact
   ▼  [merge]           PatientProvidedRecordAdded   record entries, source PATIENT_PROVIDED
   ▼                    → timeline, rag-indexer, conflict check
```

- Every bracketed step is a consumer of the previous step's event (§4).
- **Patient review is the only gate into the record.** Nothing extracted enters the record without a confirm or correct.
- **The original is never modified.** The upload's bytes and `sha256` stay as stored. Page images are derived copies, and so are text, translation and facts.

## 2. Data model

One migration. All models are tenant-scoped through the source document's facility and join the tenancy sweep and the facility-consistency gate.

### 2.1 Source: the existing upload

The pipeline works on `ClinicalDocument` rows uploaded by a patient (`uploadedByUserId` set) or, later, a proxy.

- No column of the source changes.
- One new nullable column, `processingId`, so the portal can show status.
- Verified hospital documents never go through the pipeline: they are already structured records.

### 2.2 `DocumentProcessing`: one run of the pipeline over one document

| Field | Notes |
|---|---|
| `id`, `facilityId`, `patientId`, `documentId` | Unique on `(documentId, run)`. |
| `run` | Starts at 1. A re-run (new model, patient asked for a retry) is a new row. Old runs are kept until superseded facts are resolved. |
| `status` | `QUEUED`, `RUNNING`, `AWAITING_REVIEW`, `COMPLETED`, `FAILED`, `CANCELLED`. |
| `steps` | One row per step in `DocumentProcessingStep` (below). |
| `targetLanguage` | The patient's app language when the run started. |
| `pageCount` | |
| `startedAt`, `completedAt` | |
| `version` | For compare-and-set. |

`DocumentProcessingStep`:

| Field | Notes |
|---|---|
| `processingId`, `step` | `step` is `PAGE_SPLIT`, `OCR`, `TRANSLATE`, `EXTRACT` or `MERGE`. Unique together. |
| `status` | `PENDING`, `RUNNING`, `DONE`, `SKIPPED`, `FAILED`. |
| `attempts`, `lastErrorCode` | The error code is closed: `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `UNREADABLE`, `UNSUPPORTED_LANGUAGE`, `EXACT_COPY_VIOLATION`, `TOO_LARGE`, `INTERNAL`. Never provider text. |
| `provider`, `model` | |
| `startedAt`, `finishedAt` | |

### 2.3 `ExtractedText`: OCR output per page

| Field | Notes |
|---|---|
| `id`, `processingId`, `pageNo` | Unique on `(processingId, pageNo)`. |
| `pageImageRef` | Storage ref of the rendered page (derived; same bucket and access as the upload). |
| `text` | Plain text in reading order. |
| `layout` | JSON: lines with bounding boxes, used to reference regions. |
| `language` | ISO 639-1; `mixed` with per-line languages in `layout`. |
| `script` | `Latn`, `Deva`, `Beng`, …. |
| `handwritten` | Boolean. |
| `confidence` | 0–1 for the page. Per-line confidence lives in `layout`. |
| `provider`, `model`, `createdAt` | |

### 2.4 `Translation`: per page, per target language

| Field | Notes |
|---|---|
| `id`, `extractedTextId`, `targetLanguage` | Unique together. |
| `text` | The translated text, with protected spans restored (§5). |
| `protectedSpans` | JSON: each span's type, original string and offsets in both texts. |
| `exactCopyCheck` | `PASSED` or `FAILED`. A failed translation is stored for diagnosis but never shown. |
| `provider`, `model`, `createdAt` | |

If the page is already in the target language there is no translation row; the step is `SKIPPED`.

### 2.5 `ExtractedFact`: one candidate fact

| Field | Notes |
|---|---|
| `id`, `processingId`, `facilityId`, `patientId` | |
| `factType` | `DOCUMENT_META` (document type, date, doctor, hospital), `DIAGNOSIS`, `MEDICATION`, `LAB_VALUE`, `PROCEDURE`, `ALLERGY`. |
| `value` | JSON validated by a strict Zod schema per `factType` (below). |
| `confidence` | 0–1, computed as in §7. |
| `confidenceBand` | `HIGH`, `MEDIUM` or `LOW`. LOW is flagged in review. |
| `pageNo`, `region` | The bounding box on the page image. `sourceText` is the exact original span the fact came from. |
| `exactCopyCheck` | `PASSED` or `FAILED` (§5.3). |
| `reviewStatus` | `PENDING`, `CONFIRMED`, `CORRECTED` or `REJECTED`. |
| `reviewedValue` | The patient's corrected value (CORRECTED only), validated by the same schema. |
| `reviewedByUserId`, `reviewedAt`, `reviewedVia` | `reviewedVia` is `SELF` or `PROXY` (with the proxy grant id). |
| `recordEntryId` | Set by merge. |
| `version` | Compare-and-set: a fact is decided once. |

Value schemas (strict; strings are kept as the original text where §5 says so):

| `factType` | Value |
|---|---|
| `DOCUMENT_META` | `{ documentType: PRESCRIPTION \| LAB_REPORT \| IMAGING_REPORT \| DISCHARGE_SUMMARY \| CONSULTATION_NOTE \| OTHER, documentDate?, doctorName?, registrationNo?, facilityName? }` |
| `DIAGNOSIS` | `{ text (original), icd10?, status?: ACTIVE \| RESOLVED \| HISTORY, onsetDate? }` |
| `MEDICATION` | `{ name (exact), strength? (exact), form?, dose (exact), route?, frequency (exact) + frequencyCode?, duration?, instructions? }` |
| `LAB_VALUE` | `{ analyte (exact), value (exact string), numericValue?, unit (exact), referenceRange? (exact), flag?: H \| L \| N, specimenDate? }` |
| `PROCEDURE` | `{ text (original), date?, facilityName? }` |
| `ALLERGY` | `{ substance (exact), reaction?, severity? }` |

### 2.6 `PatientProvidedRecord`: confirmed facts in the record

Hospital models can't hold patient-provided facts honestly:
- `Diagnosis` requires an `encounterId`;
- `LabResult` requires a `labOrderId`;
- `MedicationReconciliation` requires an encounter.

Forcing uploads into them would invent encounters and orders and blur verified with patient-provided, which principle 4 forbids. So confirmed facts land in one model of their own:

| Field | Notes |
|---|---|
| `id`, `facilityId`, `patientId` | |
| `kind` | `DIAGNOSIS`, `MEDICATION_HISTORY`, `LAB_RESULT`, `PROCEDURE`, `ALLERGY`. |
| `value` | JSON, the same per-kind schemas as §2.5 (the confirmed or corrected value). |
| `source` | Always `PATIENT_PROVIDED`. A CHECK constraint enforces it; the column is there so union views with verified data carry the label. |
| `factId`, `documentId`, `pageNo`, `region` | Provenance back to the fact, the original page and the region. |
| `effectiveDate?` | From the value or the document date. |
| `status` | `ACTIVE`, `WITHDRAWN` (the patient removed it) or `SUPERSEDED` (a corrected re-run). |
| `version`, `createdAt`, `withdrawnAt` | |

## 3. How a confirmed fact becomes a record entry

| Fact | Becomes | Notes |
|---|---|---|
| `DIAGNOSIS` | `PatientProvidedRecord` (DIAGNOSIS) | Shown in the problem area as "reported by patient". It never becomes a hospital `Diagnosis` and never enters `Problem` unless a clinician adds it (and then the clinician's entry is verified). |
| `MEDICATION` | `PatientProvidedRecord` (MEDICATION_HISTORY) | Offered to clinicians as a source at medication reconciliation, as `ReconciliationSource` "patient-provided document". |
| `LAB_VALUE` | `PatientProvidedRecord` (LAB_RESULT) | Trended alongside verified results, visibly labelled. |
| `PROCEDURE` | `PatientProvidedRecord` (PROCEDURE) | |
| `ALLERGY` | `PatientProvidedRecord` (ALLERGY) **and** an `Allergy` row with `verification = UNCONFIRMED`, `source = PATIENT_PROVIDED` (new column, default `CLINICIAN`) and `patientProvidedRecordId` | The one exception, for safety: allergy checks at prescribing read `Allergy`, so a patient-reported allergy must reach them. A clinician can confirm it (it becomes `CONFIRMED`) or mark it entered in error. |
| `DOCUMENT_META` | Fields on the processing run, shown on the timeline (document date, doctor, hospital) | Never a record entry. |

Merge rules:
- Merge runs once per fact (`recordEntryId` unique), in the transaction that marks the fact merged.
- It emits `PatientProvidedRecordAdded` (and `AllergyListUpdated` for allergies, as every allergy write already does).
- Withdrawing or correcting later emits `PatientProvidedRecordUpdated` (`WITHDRAWN` or `CORRECTED`).

## 4. Steps as consumers, and their events

### 4.1 Consumers

| Consumer | Handles | Does | Emits |
|---|---|---|---|
| `doc-page-split` | `PatientDocumentUploaded`, `DocumentReprocessRequested` | Creates the run (if none is open); renders PDF pages and normalizes images (orientation, resolution); stores page images | `DocumentPagesPrepared` |
| `doc-ocr` | `DocumentPagesPrepared` | OCR per page through the vision adapter | `DocumentTextExtracted` (one per run, after all pages) |
| `doc-translate` | `DocumentTextExtracted` | Per page: skip if already in the target language, otherwise translate with protected spans (§5) | `DocumentTranslated` (`skipped: true` when no page needed it) |
| `doc-extract` | `DocumentTranslated` | Extract facts from the **original** text and layout (never from a translation); compute confidence and exact-copy checks | `DocumentFactsExtracted` (fact count by band); run → `AWAITING_REVIEW` |
| `doc-merge` | `ExtractedFactReviewed` | For CONFIRMED or CORRECTED facts, create the record entry; when no PENDING fact remains, run → `COMPLETED` | `PatientProvidedRecordAdded`; `DocumentProcessingCompleted` |
| `doc-conflicts` | `PatientProvidedRecordAdded`, and the verified-record events (`LabResultReleased`, `DiagnosisRecorded`, `AllergyListUpdated`, `MedicationVerified`) | Conflict detection (§8) | `RecordConflictDetected` |

### 4.2 Event contracts

Strict Zod contracts with IDs and closed codes only: no text, values, names or languages beyond codes.

| Event | Payload |
|---|---|
| `DocumentPagesPrepared` | `processingId`, `documentId`, `patientId`, `pageCount` |
| `DocumentTextExtracted` | `processingId`, `documentId`, `patientId`, `pageCount`, `languages[]` (codes), `handwritten` (boolean), `confidenceBand` |
| `DocumentTranslated` | `processingId`, `documentId`, `patientId`, `targetLanguage`, `translatedPages`, `skipped` |
| `DocumentFactsExtracted` | `processingId`, `documentId`, `patientId`, `factCount`, `lowConfidenceCount` |
| `ExtractedFactReviewed` | `factId`, `processingId`, `patientId`, `factType`, `decision` (CONFIRMED \| CORRECTED \| REJECTED), `via` (SELF \| PROXY) |
| `PatientProvidedRecordAdded` | `recordId`, `patientId`, `kind`, `factId`, `documentId` |
| `PatientProvidedRecordUpdated` | `recordId`, `patientId`, `kind`, `change` (CORRECTED \| WITHDRAWN) |
| `DocumentProcessingCompleted` | `processingId`, `documentId`, `patientId`, `confirmed`, `corrected`, `rejected` |
| `DocumentProcessingFailed` | `processingId`, `documentId`, `patientId`, `step`, `errorCode` |
| `DocumentReprocessRequested` | `processingId`, `documentId`, `patientId`, `reason` (MODEL_UPGRADE \| PATIENT_REQUEST \| LANGUAGE_CHANGED) |
| `RecordConflictDetected` | `conflictId`, `patientId`, `kind`, `patientProvidedRecordId`, `verifiedSourceType`, `verifiedSourceId` |

- `ExtractedFactReviewed` and `PatientProvidedRecord*` are SENSITIVE: they reveal what is in a patient's outside records.
- The rest are INTERNAL.
- All are facility-scoped to the source document's facility.

### 4.3 Resumable and idempotent

- **Idempotency key per step:** `(processingId, step)`, plus `pageNo` for page-level work.
  - A step whose row is `DONE` does nothing on redelivery.
  - A `RUNNING` step older than the claim timeout is re-run.
  - Page-level results are written per page, so a resumed OCR skips pages that already have `ExtractedText`.
- **Provider calls happen outside transactions.** Each result is written in a short transaction that re-checks the step's status (compare-and-set on the step row). The step's event is emitted in that same transaction.
- **Ordering:** per-aggregate ordering on the run (aggregate `DOCUMENT_PROCESSING`) keeps steps in sequence even under redelivery.
- **Failures:**
  - Transient errors (`PROVIDER_UNAVAILABLE`, `RATE_LIMITED`) retry with the dispatcher's backoff.
  - Permanent errors (`UNREADABLE`, `UNSUPPORTED_LANGUAGE`, `TOO_LARGE`, `EXACT_COPY_VIOLATION` after the stricter retry in §5.2) set the step and run to `FAILED` and emit `DocumentProcessingFailed`.
  - On failure the patient sees "We couldn't read this document; it is saved as it is." The original is always kept.
  - A dead letter is reserved for bugs (a run or document that can't be loaded).
- **Cancellation:** if the patient deletes or withdraws the upload, the run → `CANCELLED` and its PENDING facts are discarded. Merged entries are withdrawn with `PatientProvidedRecordUpdated`.

## 5. Exact-copy rules

Medicine names, doses, units, numbers and lab values must never be translated, rounded, reformatted or "corrected" by a model.

### 5.1 Protected spans

Before translation, a deterministic tokenizer marks protected spans in the OCR text:
- **Numbers:** any digit sequence, with decimal points and commas, ranges (`4.0–6.0`), ratios (`120/80`) and dates.
- **Units:** from a closed unit list (`mg`, `mcg`, `g`, `ml`, `IU`, `mmol/L`, `mg/dL`, `g/dL`, `%`, `/µL`, `x10^3/µL`, …).
- **Dose and frequency notations:** `1-0-1`, `OD`, `BD`, `TDS`, `QID`, `HS`, `SOS`, `PRN`, `stat`, `x 5 days`.
- **Medicine names:** a dictionary of generic and Indian brand names (seeded from the formulary and an open drug list), matched case-insensitively in Latin and in transliterated Devanagari. Unknown capitalised tokens next to a dose are also protected.
- **Lab analytes:** from a closed analyte list (with LOINC display names), plus their common abbreviations.

### 5.2 Translation with placeholders

1. Protected spans are replaced with placeholders (`⟦P1⟧`, `⟦P2⟧`, …) before the text goes to the translation provider.
2. The provider is instructed to keep placeholders unchanged.
3. Afterwards the placeholders are restored from the stored originals.
4. **Check:** the multiset of placeholders in the output must equal the input's.
   - On a mismatch the translation is retried once, with a stricter prompt.
   - If it still fails, the page's translation is `FAILED`, it is never shown, and the patient sees the original with a note.
5. The model never sees a protected value it could alter. The restored values are the original bytes.

### 5.3 Facts

- **Extraction reads the original text, never a translation.**
- For every exact field of a fact (§2.5 marks them), the extracted string must occur **verbatim** in the cited `sourceText`, which must occur verbatim in the page's OCR text (comparison normalizes whitespace only).
- `numericValue` must parse from `value` exactly (no rounding).
- If any check fails: `exactCopyCheck = FAILED`, the confidence band is forced to `LOW`, and the field is highlighted in review.
- **A patient correction** is free text for exact fields, but it is stored exactly as typed and shown back for confirmation before it is accepted.

### 5.4 Tests

- **Unit, property-based:**
  - for random texts with planted numbers, units and drug names, protection then restoration is the identity;
  - a translator mock that alters, drops or duplicates a placeholder is always caught.
- **Unit, golden:** each evaluation sample's protected spans match its expected list.
- **Gate:** `verify-postgres-document-pipeline` asserts:
  - confirmed facts' exact fields equal the source spans byte for byte;
  - a planted translation corruption never reaches a stored `PASSED` translation.
- **Evaluation:** 100% exact numbers and doses in confirmed facts (§10).

## 6. Adapters

Per ADR 0003, behind interfaces in `src/lib/ai/documents`, each chosen by configuration and replaced by a deterministic mock whenever no key is set. CI never needs a key.

```ts
interface VisionOcrProvider {
  readonly id: "claude" | "mock";
  ocrPage(image: Buffer, hints: { languages?: string[] }): Promise<{ text: string; layout: Line[]; language: string; script: string; handwritten: boolean; confidence: number }>;
}
interface TranslationProvider {
  readonly id: "claude" | "mock";
  translate(text: string, from: string, to: string): Promise<string>; // text contains placeholders
}
interface FactExtractor {
  readonly id: "claude" | "mock";
  extract(page: { text: string; layout: Line[]; language: string }): Promise<CandidateFact[]>;
}
```

- **Real providers:**
  - Claude vision for OCR;
  - Claude for translation and extraction;
  - models from config, defaulting to Claude Haiku 5.5 (`claude-haiku-5-5`) per the RAG design §6.1.
- **Low-confidence retry:** a page with low OCR confidence or handwriting is retried once with Claude Sonnet 5.5 (`ai.model.ocr_retry`). The better of the two results is kept, with its model recorded.
- **Mocks:**
  - **OCR mock:** the evaluation samples are generated from ground-truth fixtures, and each image's sha256 maps to its fixture text and layout. An unknown image gives a deterministic `UNREADABLE`.
  - **Translation mock:** a word-level glossary per language pair from the fixtures. It passes placeholders through, and can be switched to corrupt them for tests.
  - **Extraction mock:** rule-based over the fixture text, emitting facts with fixture-defined confidences.
- **Not sent to any provider:** the patient's name, phone, UHID or ABHA number. Pages go as images. Prompts carry no identifiers.

## 7. Confidence

A model's self-reported confidence isn't calibrated, so the band combines signals:

| Signal | Effect |
|---|---|
| OCR line confidence of the fact's region | Base score |
| Exact-copy check (§5.3) failed | Forced `LOW` |
| Handwritten page | At most `MEDIUM` |
| Two-pass agreement on exact fields (the extractor run twice with different prompts, or the OCR retry model) | Disagreement forces `LOW` |
| Schema completeness (a medication with no dose, a lab value with no unit) | One band lower |

- **Thresholds:** `HIGH` ≥ 0.9, `LOW` < 0.7. They are calibrated on the evaluation set and kept in config.
- **No auto-confirm.** Even `HIGH` facts wait for the patient. The review screen pre-selects "confirm" only for `HIGH` facts, and the patient still submits.

## 8. Conflicts with verified records

### 8.1 Detection

`doc-conflicts` compares each patient-provided record with the patient's verified data of the same kind:

| Kind | Conflict when |
|---|---|
| LAB_RESULT | Same analyte (by code or normalized name) and same specimen date (±1 day), with different values or units |
| ALLERGY | The verified allergy list marks the same substance `ENTERED_IN_ERROR` or `INACTIVE`; or a verified "no known allergies" was recorded after the document date |
| MEDICATION_HISTORY | Same drug with a different dose or frequency during an overlapping period of a verified active order |
| DIAGNOSIS | Same ICD-10 code (or normalized text), where verified says `RESOLVED` or `ENTERED_IN_ERROR` and the upload says active, dated later than the verified change |

Each conflict is a `RecordConflict` row:
- `patientId`, `kind`;
- both references;
- `detectedAt`;
- `status`: `OPEN`, `ACKNOWLEDGED`, or `RESOLVED_BY_CLINICIAN`.

It emits `RecordConflictDetected`. Re-detection is idempotent on the pair.

### 8.2 Display

- Wherever either entry appears, the verified value is shown first, with "Your uploaded report says …" and a link to the original page.
- The AI cites both and states the disagreement (RAG §2).
- A clinician can acknowledge the conflict, or resolve it by recording a verified entry. Patients can withdraw their entry.
- Nothing is overwritten automatically, in either direction.

## 9. Patient review API and proxy permissions

All routes call services, never tables directly. Responses carry no other patient's data and are audited like other record reads.

| Route | Does |
|---|---|
| `GET /api/patient/documents/:id/processing` | Run status, steps (status only), page count, languages, whether a translation exists |
| `GET /api/patient/documents/:id/pages/:n` | The original page image, plus the OCR text and translation side by side (each labelled) |
| `GET /api/patient/facts?status=PENDING` | Pending facts across the patient's documents, LOW first, each with `sourceText`, page and region, and the translated label of its type |
| `POST /api/patient/facts/:id/confirm` | → CONFIRMED (compare-and-set on `version`) |
| `POST /api/patient/facts/:id/correct` | `{ value }`, validated by the type's schema → CORRECTED |
| `POST /api/patient/facts/:id/reject` | → REJECTED (never merged; kept for evaluation) |
| `POST /api/patient/facts/bulk` | Confirm or reject several facts. HIGH facts only for bulk confirm; LOW facts must be decided one by one. |
| `POST /api/patient/records/:id/withdraw` | Withdraw a merged patient-provided entry |
| `POST /api/patient/documents/:id/reprocess` | Ask for a fresh run (for example after changing app language) |

**Permissions:**
- **The patient** can do everything.
- **A proxy:**
  - viewing pending facts needs **view** and the `UPLOADS` category (plus each fact's own category);
  - confirm, correct, reject, withdraw and reprocess need **upload**;
  - sensitive categories are hidden from proxies unless the member allowed them, so a fact in a sensitive category never appears in a proxy's review list.
- **Until households (5b):** the existing delegation model has no upload scope, and today only the patient can upload (`uploadPatientDocument` refuses delegates). So in Week 4a, review is **patient-only**. The permission checks are written against a `can(actor, "upload", patient)` function that 5b fills in.
- **Clinicians** never confirm patient facts. They see confirmed ones, labelled.
- **Minors:** facts are reviewed by the guardian proxy.

## 10. Evaluation

### 10.1 Sample set: 50 synthetic reports

| Type | Count | Languages and forms |
|---|---|---|
| Printed lab reports (CBC, LFT, KFT, lipid, HbA1c, thyroid) | 15 | English, Hindi, Marathi, Tamil, Bengali |
| Prescriptions, printed | 8 | English, Hindi, Gujarati |
| Prescriptions, **handwritten-style** (rendered with handwriting fonts and noise) | 10 | English, Hindi, Marathi, Telugu |
| Discharge summaries | 7 | English, Hindi, Kannada |
| Imaging reports | 5 | English, Marathi |
| Mixed-language pages (English values in a Hindi or Tamil report) | 5 | Hindi + English, Tamil + English |

That is at least 9 languages, beyond the required 5.

- **Generation:** each sample is generated from a ground-truth fixture (expected facts, protected spans, language) by a script, so the expected answers are exact by construction.
- **Noise:** skew, blur, shadows, stamps, folded corners.
- **No real documents.**
- **Hand-made extras:** a few samples are made by hand to test the generator's blind spots. Their expected facts are written by the team and marked "pending clinical advisor sign-off" (shared with the RAG evaluation's sign-off).

### 10.2 Scoring: `npm run eval:documents [-- --provider real]`

- **Exactness (target 100%):** every exact field of every confirmed fact equals the source byte for byte. Measured on a simulated review that confirms only facts the fixture says are correct.
- **Field accuracy (measured and reported; target set after the first real run):**
  - precision and recall per fact type and per field;
  - language and handwriting broken out.
- **Calibration:** LOW-band recall of wrong fields. The share of wrong fields flagged LOW should be at least 95%.
- **Gating (target: no exceptions):** no fact enters the record without a confirm or correct.
- **Translation:** the exact-copy check passes on 100% of shown translations. Failures are counted and must be shown as originals.
- **Cost and latency** per page.

In CI the scorer runs against the mocks as a plumbing check. It proves gating, exactness and resumability, not model quality. The real run is manual, on synthetic data, and recorded in the PR.

## 11. Privacy

- **The same real-data switch as RAG** (`docs/RAG_DESIGN.md` §11):
  - with `AI_REAL_DATA_ENABLED=false` (the default), every pipeline consumer skips documents of facilities not marked `SYNTHETIC`;
  - skips are recorded on the run as `SKIPPED` with reason `REAL_DATA_DISABLED`;
  - uploads still work and are stored as they are.
- **Before real data:**
  - a data processing agreement with the OCR, translation and extraction processor (Anthropic), with zero retention;
  - the DPDP cross-border check;
  - patient consent for the purpose `DOCUMENT_PROCESSING` (new; guardian consent for minors);
  - clinical advisor sign-off on the fact types and the conflict rules.
- **Derived data follows the original.**
  - Page images, text, translations and facts are deleted with the upload, on erasure, or on withdrawal of `DOCUMENT_PROCESSING` consent.
  - Merged entries are then withdrawn.
  - A legal hold on the record keeps them.
- **Logs** carry IDs and error codes only, never text.

## 12. Order of wiring, each step with its gate

Each step is its own commit. `verify:all`, `npm test`, lint and build stay green after each. Steps 1–2 are shared with RAG (whichever phase lands first builds them).

| # | Step | Gate |
|---|---|---|
| 1 | The real-data switch and consent purposes (`DOCUMENT_PROCESSING`; RAG's `AI_ASSISTANCE` and `AI_TEXT_RETENTION`) | `verify-postgres-ai-switch`: REAL facilities are skipped everywhere. |
| 2 | Model config (`ai.model.*`) and the adapters with mocks (OCR, translation, extraction) | Unit tests: mocks are deterministic; no real provider without a key. |
| 3 | Protected-span tokenizer and placeholder translation | Property-based and golden unit tests (§5.4). |
| 4 | Models and migration: `DocumentProcessing`, `DocumentProcessingStep`, `ExtractedText`, `Translation`, `ExtractedFact`, `PatientProvidedRecord`, `RecordConflict`, `Allergy.source` and `patientProvidedRecordId`, `ClinicalDocument.processingId`. CHECK constraints (source = PATIENT_PROVIDED; a decided fact has its reviewer and time). Tenancy sweep and facility-consistency entries. | Migration on a fresh database; drift check; constraint tests; tenancy sweep. |
| 5 | Event contracts (§4.2) and the consumers `doc-page-split`, `doc-ocr`, `doc-translate`, `doc-extract`. Registered; the catalogue doc regenerates. | `verify-postgres-document-pipeline` part 1: upload → AWAITING_REVIEW with mock providers; replay creates nothing; killed mid-OCR resumes without redoing pages; transient failure retries; unreadable page → FAILED with the original kept; REAL facility skipped. |
| 6 | Review services and API (§9), with compare-and-set on facts | Part 2: confirm, correct and reject; a concurrent double decision is decided once; LOW cannot be bulk-confirmed; another patient's fact gives 404; a delegate is refused (until 5b). |
| 7 | `doc-merge`, `PatientProvidedRecord` and the allergy bridge | Part 3: only confirmed or corrected facts become entries; exact fields equal the source spans; a patient-provided allergy reaches the prescribing allergy check as UNCONFIRMED; withdraw emits its event. |
| 8 | `doc-conflicts` and the conflict display data | Part 4: each conflict rule fires once per pair; verified shown first; nothing overwritten. |
| 9 | Timeline and RAG hooks (the `rag-indexer` subscriptions in RAG §5.1) | The core journey: an upload → review → merge → timeline entry → indexed as PATIENT_PROVIDED; no unconfirmed fact indexed. |
| 10 | Evaluation set, generator and scorer | CI: the mock run with the gating and exactness targets. Manually, with real providers: the §10.2 report, recorded in the PR. |
| 11 | Patient UI: processing status, the side-by-side original and translation, the review screen (LOW first) | UI tests and a smoke test against the mocks. |

## 13. Decisions taken for you

All take the more conservative option and can be reversed.

- **Patient-provided facts get their own model** (`PatientProvidedRecord`), not rows in `Diagnosis`, `LabResult` or medication reconciliation. Those require encounters or orders, which would have to be invented.
- **Allergies are the exception:** they also land in `Allergy` as `UNCONFIRMED` with `source = PATIENT_PROVIDED`, so prescribing safety checks see them. Safety favours inclusion.
- **Extraction reads the original text, never a translation.**
- **No auto-confirm,** not even at HIGH confidence. Bulk confirm is allowed for HIGH facts only.
- **A translation that fails the exact-copy check is never shown**, even partially. The original is shown instead.
- **Low-confidence and handwritten pages are retried once with Sonnet 5.5.** Haiku 5.5 is the default for OCR and extraction.
- **Review is patient-only in Week 4a.** Proxy permissions are designed and stubbed behind `can()` until households (5b), because the current delegation model has no upload scope.
- **A new consent purpose, `DOCUMENT_PROCESSING`,** is required before real data, separate from `AI_ASSISTANCE`, since DPDP consent is per purpose.
- **Rejected facts are kept** (never merged) for evaluation, and deleted with the document.

## 14. Open questions

1. **Drug dictionary source.** Which list seeds medicine-name protection (an open generic list, CDSCO, a commercial Indian brand list)? Licensing matters.
2. **Clinician view of patient-provided facts.** Inside the treating facility without a share, should clinicians see confirmed patient-provided entries by default? They are patient-visible uploads today, so the design says yes, labelled. Or only when shared through 4c?
3. **Re-processing on a language change.** If a patient changes app language, should all past documents be re-translated automatically (cost), or on demand? The design says on demand.
4. **Field-accuracy targets.** Set them after the first real run, or fix them now (for example ≥ 95% for lab values on printed reports)?
5. **Handwriting.** Should handwritten prescriptions be supported for extraction at all in 4a, or kept to OCR and translation only, with every field forced LOW?
6. **Patient uploads and facility tenancy.** Today an upload belongs to the patient's facility (`ClinicalDocument.facilityId`). The lifelong, cross-hospital record in the vision needs a person-level home for patient-provided data. Does that wait for a person-level patient identity (EMPI), or should 4a introduce it?
