# Document pipeline: design (Week 4a)

- **Status:** Design, revision 2, for review. No code yet.
- **Date:** 2026-10-17
- **Revision 2:**
  - ownership re-pointed to the Person (`docs/PERSON_IDENTITY_DESIGN.md`, Phase 0, which comes first);
  - product decisions 2–11 applied (§13.1);
  - revision 1's open questions answered.
- **Branch:** `foundation/w4-intelligence`
- **Spec:** `docs/PRODUCT_SPEC.md` feature A, principles 4 (verified vs patient-provided), 5 (originals never replaced) and 8 (AI assists, never decides).
- **Builds on:**
  - **Person identity (Phase 0):** uploads, pipeline data, patient-provided facts and patient-given consents belong to the `Person`, not to a facility;
  - patient uploads: today `uploadPatientDocument` writes a `ClinicalDocument` to the private `patient-uploads` bucket (PDF, JPEG, PNG or WebP, content-checked, at most 15 MB) and emits `PatientDocumentUploaded`; Phase 0 moves new uploads to `PersonDocument`;
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
15. As built (Week 4a)

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

One migration.
- **Every model is person-scoped:** each carries `personId` and no `facilityId`.
- **They join the PERSON tenancy segment** (Person design §8.1). Every read goes through `personAccess()`.
- **They are exempt from the facility-consistency rule.**

### 2.1 Source: `PersonDocument`

The pipeline works on `PersonDocument` rows, the person-owned uploads introduced in Phase 0 (Person design §7, §10.3).
- **Uploaded by:** the person (an OWNER login) or, from 5b, a proxy with the upload permission.
- **Bytes:** stored through the storage adapter in the private `patient-uploads` bucket, with the existing checks.
- **The original never changes:** its `sha256` is fixed at upload.
- **One new nullable column,** `processingId`, so the app can show status.

Hospital `ClinicalDocument`s (verified, facility-owned) never go through the pipeline: they are already structured records. A pre-Phase-0 upload that the migration could not move stays a `ClinicalDocument` and is processed only after it has moved.

### 2.2 `DocumentProcessing`: one run of the pipeline over one document

| Field | Notes |
|---|---|
| `id`, `personId`, `documentId` | `documentId` is the `PersonDocument`. Unique on `(documentId, run)`. |
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
| `handwritten` | Boolean. Handwritten pages carry the label through to facts and record entries (§7, §9). |
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
| `id`, `processingId`, `personId` | |
| `factType` | `DOCUMENT_META` (document type, date, doctor, hospital), `DIAGNOSIS`, `MEDICATION`, `LAB_VALUE`, `PROCEDURE`, `ALLERGY`. |
| `value` | JSON validated by a strict Zod schema per `factType` (below). |
| `confidence` | 0–1, computed as in §7. |
| `confidenceBand` | `HIGH`, `MEDIUM` or `LOW`. LOW is flagged in review. |
| `handwritten` | Copied from the page. Shown as a "handwritten" label, and requires per-field confirmation (§9). |
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
| `id`, `personId` | Owned by the Person. Facilities see it only under Person design §8.2–8.3. |
| `kind` | `DIAGNOSIS`, `MEDICATION_HISTORY`, `LAB_RESULT`, `PROCEDURE`, `ALLERGY`. |
| `value` | JSON, the same per-kind schemas as §2.5 (the confirmed or corrected value). |
| `source` | Always `PATIENT_PROVIDED`. A CHECK constraint enforces it; the column is there so union views with verified data carry the label. |
| `factId`, `documentId`, `pageNo`, `region` | Provenance back to the fact, the original page and the region. |
| `handwritten` | From the fact; shown as a label wherever the entry appears. |
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
| `ALLERGY` | `PatientProvidedRecord` (ALLERGY). It is **also bridged** to an `Allergy` row (`verification = UNCONFIRMED`, `source = PATIENT_PROVIDED`, a new column defaulting to `CLINICIAN`, and `patientProvidedRecordId`) at each facility where the person has an ACTIVE link **and** has opted in to sharing uploads with treating hospitals | For safety: allergy checks at prescribing read `Allergy`, so a shared patient-reported allergy must reach them. A clinician can confirm it (`CONFIRMED`) or mark it entered in error. When the opt-in is withdrawn or the link ends, bridged rows that no clinician confirmed go to `INACTIVE`, and the facility record gets a content-free flag in their place: **"Allergy information withdrawn by the patient — ask about allergies"**. The flag has no substance and no reaction. Rows a clinician confirmed are now the facility's own and stay. Before withdrawal, the patient is warned that hospitals treating them will no longer see these allergies. Clinicians are prompted to confirm allergies at the point of care (prescribing, admission, pre-op) whenever an unconfirmed patient-provided allergy or a withdrawal flag is present. |
| `DOCUMENT_META` | Fields on the processing run, shown on the timeline (document date, doctor, hospital) | Never a record entry. |

Visibility (decision 3; Person design §8.3):
- Confirmed patient-provided facts are always visible to the person.
- Treating-facility clinicians see them only while the person's "share my uploads with hospitals treating me" consent is granted, and only inside an active care relationship.
- Others see them only through a share (4c).
- There is no pre-selected default; until the person chooses, the answer is no.

Merge rules:
- Merge runs once per fact (`recordEntryId` unique), in the transaction that marks the fact merged.
- It emits `PatientProvidedRecordAdded` (and `AllergyListUpdated` for allergies, as every allergy write already does).
- Withdrawing or correcting later emits `PatientProvidedRecordUpdated` (`WITHDRAWN` or `CORRECTED`).

## 4. Steps as consumers, and their events

### 4.1 Consumers

| Consumer | Handles | Does | Emits |
|---|---|---|---|
| `doc-page-split` | `PersonDocumentUploaded` (new; scope PERSON), `DocumentReprocessRequested` | Creates the run (if none is open); renders PDF pages and normalizes images (orientation, resolution); stores page images | `DocumentPagesPrepared` |
| `doc-ocr` | `DocumentPagesPrepared` | OCR per page through the vision adapter | `DocumentTextExtracted` (one per run, after all pages) |
| `doc-translate` | `DocumentTextExtracted` | Per page: skip if already in the target language, otherwise translate with protected spans (§5) | `DocumentTranslated` (`skipped: true` when no page needed it) |
| `doc-extract` | `DocumentTranslated` | Extract facts from the **original** text and layout (never from a translation); compute confidence and exact-copy checks | `DocumentFactsExtracted` (fact count by band); run → `AWAITING_REVIEW` |
| `doc-merge` | `ExtractedFactReviewed` | For CONFIRMED or CORRECTED facts, create the record entry; when no PENDING fact remains, run → `COMPLETED` | `PatientProvidedRecordAdded`; `DocumentProcessingCompleted` |
| `doc-conflicts` | `PatientProvidedRecordAdded`, and the verified-record events (`LabResultReleased`, `DiagnosisRecorded`, `AllergyListUpdated`, `MedicationVerified`) of facility patients **linked to the Person** (the events carry `personId`; Person design §9) | Conflict detection (§8), across all of the person's ACTIVE links | `RecordConflictDetected` |

### 4.2 Event contracts

Strict Zod contracts with IDs and closed codes only: no text, values, names or languages beyond codes.

| Event | Payload |
|---|---|
| `DocumentPagesPrepared` | `processingId`, `documentId`, `personId`, `pageCount` |
| `DocumentTextExtracted` | `processingId`, `documentId`, `personId`, `pageCount`, `languages[]` (codes), `handwritten` (boolean), `confidenceBand` |
| `DocumentTranslated` | `processingId`, `documentId`, `personId`, `targetLanguage`, `translatedPages`, `skipped` |
| `DocumentFactsExtracted` | `processingId`, `documentId`, `personId`, `factCount`, `lowConfidenceCount` |
| `ExtractedFactReviewed` | `factId`, `processingId`, `personId`, `factType`, `decision` (CONFIRMED \| CORRECTED \| REJECTED), `via` (SELF \| PROXY) |
| `PatientProvidedRecordAdded` | `recordId`, `personId`, `kind`, `factId`, `documentId` |
| `PatientProvidedRecordUpdated` | `recordId`, `personId`, `kind`, `change` (CORRECTED \| WITHDRAWN) |
| `DocumentProcessingCompleted` | `processingId`, `documentId`, `personId`, `confirmed`, `corrected`, `rejected` |
| `DocumentProcessingFailed` | `processingId`, `documentId`, `personId`, `step`, `errorCode` |
| `DocumentReprocessRequested` | `processingId`, `documentId`, `personId`, `reason` (MODEL_UPGRADE \| PATIENT_REQUEST \| LANGUAGE_CHANGED) |
| `RecordConflictDetected` | `conflictId`, `personId`, `patientId` (the facility record), `kind`, `patientProvidedRecordId`, `verifiedSourceType`, `verifiedSourceId` |

- `ExtractedFactReviewed` and `PatientProvidedRecord*` are SENSITIVE: they reveal what is in a patient's outside records.
- The rest are INTERNAL.
- All are **PERSON-scoped** (`personId`, no facility), except `RecordConflictDetected`. That one is emitted once per facility whose verified record is involved, FACILITY-scoped with `personId`.

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
- **Cancellation:** if the person deletes or withdraws the upload, the run → `CANCELLED` and its PENDING facts are discarded. Merged entries are withdrawn with `PatientProvidedRecordUpdated`.

## 5. Exact-copy rules

Medicine names, doses, units, numbers and lab values must never be translated, rounded, reformatted or "corrected" by a model.

### 5.1 Protected spans

Before translation, a deterministic tokenizer marks protected spans in the OCR text:
- **Numbers:** any digit sequence, with decimal points and commas, ranges (`4.0–6.0`), ratios (`120/80`) and dates.
- **Units:** from a closed unit list (`mg`, `mcg`, `g`, `ml`, `IU`, `mmol/L`, `mg/dL`, `g/dL`, `%`, `/µL`, `x10^3/µL`, …).
- **Dose and frequency notations:** `1-0-1`, `OD`, `BD`, `TDS`, `QID`, `HS`, `SOS`, `PRN`, `stat`, `x 5 days`.
- **Medicine names (decision 2):** three sources, combined. Any one of them is enough to protect a span; none can remove another's protection.
  - **NLEM 2022.** The repository had the list as `src/lib/essential-medicines.ts` (406 entries, including 21 combinations written "A (A) + B (B)"). It was removed with the retired prototype in `18bedce` and is restored as seed reference data (`prisma/seedData/medicines/nlem2022.ts`). The restore drops the NLEM section headings that sit in the old array (e.g. "Vitamins and Minerals", "Medicines for COVID-19 Management") and splits combinations into their components, keeping the combination too.
  - **WHO INN generics.** A one-time curated, versioned import of the recommended International Nonproprietary Names (with the list number and import date recorded), refreshed yearly.
  - **Model tagging.** Claude Haiku 5.5 (`ai.model.tagging`) tags medicine spans in the OCR text, which catches Indian brand names and misspellings the lists miss. A tagged span is protected like a dictionary match. The tag never changes the text, and a span the model didn't tag but a list matched stays protected.
  - **Matching:** case-insensitive, in Latin script and in transliterated Devanagari.
  - **Unknown capitalised tokens** next to a dose are also protected.
  - **No commercial brand list until after the pilot.** Licensing it is a decision for then.
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
| Handwritten page (decision 4) | At most `MEDIUM`, and the fact carries the "handwritten" label |
| Two-pass agreement on exact fields (the extractor run twice with different prompts, or the OCR retry model) | Disagreement forces `LOW` |
| Schema completeness (a medication with no dose, a lab value with no unit) | One band lower |

- **Thresholds:** `HIGH` ≥ 0.9, `LOW` < 0.7. They are calibrated on the evaluation set and kept in config.
- **No auto-confirm.** Even `HIGH` facts wait for the person. The review screen pre-selects "confirm" only for `HIGH` facts that are not handwritten, and the person still submits.
- **Handwritten facts (decision 4):** facts are extracted from handwritten pages, but every field is confirmed one by one. The review shows each field next to its source region; there is no fact-level confirm and no bulk confirm. The entry keeps the "handwritten" label in the record, the timeline and AI citations.

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
- `personId`, the facility `patientId`, `kind`;
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
| `POST /api/patient/facts/bulk` | Confirm or reject several facts. Bulk confirm only for HIGH facts that are **not handwritten**. LOW and handwritten facts are decided one by one, and handwritten ones field by field (`POST /api/patient/facts/:id/fields/:field/confirm`). |
| `POST /api/patient/records/:id/withdraw` | Withdraw a merged patient-provided entry |
| `POST /api/patient/documents/:id/reprocess` | Ask for a fresh run (for example after changing app language) |

**Permissions:**
- **The patient** can do everything.
- **A proxy:**
  - viewing pending facts needs **view** and the `UPLOADS` category (plus each fact's own category);
  - confirm, correct, reject, withdraw and reprocess need **upload**;
  - sensitive categories are hidden from proxies unless the member allowed them, so a fact in a sensitive category never appears in a proxy's review list.
- **Until households (5b):** the existing delegation model has no upload scope, and today only the patient can upload (`uploadPatientDocument` refuses delegates). So in Week 4a, review is **owner-only** (the Person's OWNER login). The checks go through `personAccess()` (Person design §8.1), which 5b extends with proxy permissions.
- **Routes** resolve the Person from the session, never from the request; a document or fact of another Person is a 404.
- **Clinicians** never confirm patient facts. They see confirmed ones, labelled.
- **Minors:** facts are reviewed by the guardian proxy (5b).
- **Turning 18 (decision 10):** every guardian-given consent, including `DOCUMENT_PROCESSING`, lapses to "needs your confirmation". Until the member confirms, no new pipeline run starts, and pending facts can't be confirmed by the former guardian.

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
- **Hand-made extras:** a few samples are made by hand to test the generator's blind spots. Their expected facts are written by the team and marked **"pending clinical advisor"** (decision 11), shared with the RAG evaluation's sign-off. The clinical advisor is not yet named; the real-data switch stays off until they sign off.

### 10.2 Scoring: `npm run eval:documents [-- --provider real]`

- **Exactness (target 100%):** every exact field of every confirmed fact equals the source byte for byte. Measured on a simulated review that confirms only facts the fixture says are correct.
- **Field accuracy (provisional targets, decision 5; revisit after the first benchmark):**
  - **≥ 90%** on printed documents;
  - **≥ 75%** on handwritten ones;
  - measured as precision and recall per fact type and per field, with language and handwriting broken out.
- **Calibration:** LOW-band recall of wrong fields. The share of wrong fields flagged LOW should be at least 95%.
- **Gating (target: no exceptions):** no fact enters the record without a confirm or correct.
- **Translation:** the exact-copy check passes on 100% of shown translations. Failures are counted and must be shown as originals.
- **Cost and latency** per page.

In CI the scorer runs against the mocks as a plumbing check. It proves gating, exactness and resumability, not model quality. The real run is manual, on synthetic data, and recorded in the PR.

## 11. Privacy

- **The same real-data switch as RAG** (`docs/RAG_DESIGN.md` §11). Person-level data has no facility, so a Person carries `dataClassification` (`REAL` by default; `SYNTHETIC` only for seeded demo Persons):
  - with `AI_REAL_DATA_ENABLED=false` (the default), every pipeline consumer skips documents of Persons not marked `SYNTHETIC`;
  - the switch stays off until the clinical advisor signs off (decision 11);
  - skips are recorded on the run as `SKIPPED` with reason `REAL_DATA_DISABLED`;
  - uploads still work and are stored as they are.
- **Before real data:**
  - a data processing agreement with the OCR, translation and extraction processor (Anthropic), with zero retention;
  - the DPDP cross-border check;
  - patient consent for the purpose `DOCUMENT_PROCESSING` (new; guardian consent for minors);
  - clinical advisor sign-off on the fact types and the conflict rules (**pending clinical advisor**).
- **Facilities never receive pipeline data** except confirmed facts under the opt-in (§3) or a share.
- **Derived data follows the original.**
  - Page images, text, translations and facts are deleted with the upload, on erasure, or on withdrawal of `DOCUMENT_PROCESSING` consent.
  - Merged entries are then withdrawn.
  - A legal hold on the record keeps them.
- **Logs** carry IDs and error codes only, never text.

## 12. Order of wiring, each step with its gate

Each step is its own commit. `verify:all`, `npm test`, lint and build stay green after each.
- **Prerequisite:** Phase 0 (Person identity) is complete, including `PersonDocument` and the upload-sharing consent.
- **Shared steps:** steps 1–2 are shared with RAG (whichever phase lands first builds them).

| # | Step | Gate |
|---|---|---|
| 1 | The real-data switch and consent purposes (`DOCUMENT_PROCESSING`; RAG's `AI_ASSISTANCE` and `AI_TEXT_RETENTION`) | `verify-postgres-ai-switch`: REAL facilities are skipped everywhere. |
| 2 | Model config (`ai.model.*`) and the adapters with mocks (OCR, translation, extraction) | Unit tests: mocks are deterministic; no real provider without a key. |
| 3 | Medicine reference data (NLEM 2022 restored from `18bedce` and cleaned; WHO INN), the protected-span tokenizer with model tagging, and placeholder translation | Property-based and golden unit tests (§5.4); the restored list contains no section headings; a list match can't be removed by tagging. |
| 4 | Models and migration (all person-scoped): `DocumentProcessing`, `DocumentProcessingStep`, `ExtractedText`, `Translation`, `ExtractedFact`, `PatientProvidedRecord`, `RecordConflict`, `Allergy.source` and `patientProvidedRecordId`, `PersonDocument.processingId`, `Person.dataClassification`. CHECK constraints (source = PATIENT_PROVIDED; a decided fact has its reviewer and time; a handwritten fact is confirmed only when every field is). PERSON-segment tenancy sweep entries. | Migration on a fresh database; drift check; constraint tests; tenancy sweep. |
| 5 | Event contracts (§4.2) and the consumers `doc-page-split`, `doc-ocr`, `doc-translate`, `doc-extract`. Registered; the catalogue doc regenerates. | `verify-postgres-document-pipeline` part 1: upload → AWAITING_REVIEW with mock providers; replay creates nothing; killed mid-OCR resumes without redoing pages; transient failure retries; unreadable page → FAILED with the original kept; REAL facility skipped. |
| 6 | Review services and API (§9), with compare-and-set on facts | Part 2: confirm, correct and reject; a concurrent double decision is decided once; LOW and handwritten facts can't be bulk-confirmed; a handwritten fact needs every field confirmed; another Person's fact gives 404; a delegate is refused (until 5b). |
| 7 | `doc-merge`, `PatientProvidedRecord`, the visibility rule (§3) and the allergy bridge | Part 3: only confirmed or corrected facts become entries; exact fields equal the source spans; without the opt-in a treating facility sees nothing; with it (and a care relationship) a patient-provided allergy reaches the prescribing allergy check as UNCONFIRMED; withdrawing the opt-in inactivates unconfirmed bridged rows; withdraw emits its event. `verify-postgres-person-leaks` gains the pipeline's canaries. |
| 8 | `doc-conflicts` and the conflict display data | Part 4: each conflict rule fires once per pair; verified shown first; nothing overwritten. |
| 9 | Timeline and RAG hooks (the `rag-indexer` subscriptions in RAG §5.1) | The core journey: an upload → review → merge → timeline entry → indexed as PATIENT_PROVIDED; no unconfirmed fact indexed. |
| 10 | Evaluation set, generator and scorer | CI: the mock run with the gating and exactness targets. Manually, with real providers: the §10.2 report, recorded in the PR. |
| 11 | Patient UI: processing status, the side-by-side original and translation, the review screen (LOW first) | UI tests and a smoke test against the mocks. |

## 13. Decisions

### 13.1 Product decisions applied in revision 2 (2026-10-17)

| # | Decision | Where |
|---|---|---|
| 1 | Person identity comes first; uploads, facts and patient-given consents belong to the Person | §2, §3, §4, §9, §11 |
| 2 | Drug dictionary: NLEM plus WHO INN generics, plus model tagging of medicine spans; no commercial brand list yet | §5.1 |
| 3 | Treating-facility clinicians see confirmed patient-provided facts only with the person's affirmative opt-in | §3, §11 |
| 4 | Handwritten: extract facts, confirm field by field, no bulk confirm, label "handwritten" | §2.5, §7, §9 |
| 5 | Provisional targets: 100% exact numbers and doses; ≥ 90% field accuracy printed; ≥ 75% handwritten | §10.2 |
| 6 | Re-translate on demand | §9 (`reprocess`), §14 |
| 10 | Turning 18: guardian-given consents (including `DOCUMENT_PROCESSING`) lapse to "needs your confirmation" | §9 |
| 11 | Clinical advisor not yet named: blocked items are marked "pending clinical advisor"; the real-data switch stays off until sign-off | §10.1, §11 |

### 13.2 Decisions taken for you

All take the more conservative option and can be reversed.

- **A shared allergy is bridged only where it is shared.** It reaches a facility's `Allergy` table only where the person has an ACTIVE link and the upload-sharing opt-in. On withdrawal, unconfirmed bridged rows go INACTIVE; clinician-confirmed ones stay as the facility's.
- **Persons carry `dataClassification`** for the real-data switch, since person data has no facility. It defaults to `REAL`.
- **Model tagging only adds protection.** A list match can't be untagged.
- **Patient-provided facts get their own model** (`PatientProvidedRecord`), not rows in `Diagnosis`, `LabResult` or medication reconciliation. Those require encounters or orders, which would have to be invented.
- **Allergies are the exception:** they also land in `Allergy` as `UNCONFIRMED` with `source = PATIENT_PROVIDED`, so prescribing safety checks see them. Safety favours inclusion.
- **Extraction reads the original text, never a translation.**
- **No auto-confirm,** not even at HIGH confidence. Bulk confirm is allowed for HIGH facts only.
- **A translation that fails the exact-copy check is never shown**, even partially. The original is shown instead.
- **Low-confidence and handwritten pages are retried once with Sonnet 5.5.** Haiku 5.5 is the default for OCR and extraction.
- **Review is owner-only in Week 4a** (the Person's OWNER login). Proxy permissions are designed behind `personAccess()` and filled in by households (5b), because the current delegation model has no upload scope.
- **A new consent purpose, `DOCUMENT_PROCESSING`,** is required before real data, separate from `AI_ASSISTANCE`, since DPDP consent is per purpose.
- **Rejected facts are kept** (never merged) for evaluation, and deleted with the document.

## 14. Open questions

Revision 1's six questions are answered:
- the dictionary is decision 2;
- clinician visibility is decision 3;
- re-translation is on demand, decision 6;
- the accuracy targets are decision 5;
- handwriting is decision 4;
- facility tenancy is decision 1, Person.

What remains:

None. The three raised in revision 2 are answered (2026-10-17):
- WHO INN is a curated, versioned import refreshed yearly;
- brands come after the pilot;
- withdrawn allergies get the content-free flag, the warning and the point-of-care prompt (§3).

## 15. As built (Week 4a, 2026-10-18)

What the code does where it differs from, or adds to, the sections above. Each item takes the more conservative option.

### 15.1 Departures

- **Routes live under `/api/patient/person/`** (`documents/:id/processing`, `documents/:id/pages/:n`, `documents/:id/reprocess`, `facts…`, `records…`), next to the Phase 0 person routes, because `/api/patient/documents` and `/api/patient/records` already serve the facility-scoped portal.
- **`PersonDocument.processingId` is a relation, not a column:** a document has its runs (`processings`), the latest one is its status.
- **An exact-copy failure in translation fails the page, not the run** (§5.2 over §4.3): the failed translation is stored with the translator's raw placeholder output only and never shown; extraction reads the original anyway.
- **`DocumentTranslated` also counts `exactCopyFailures`.**
- **`PatientProvidedRecordUpdated` has a third change, `SUPERSEDED`:** a re-run of the same document that confirms an identical entry supersedes the old one (its bridged allergies move over).
- **`AllergyListUpdated` v2** adds `source` and makes `severity` optional; `Allergy.severity` is nullable only for patient-provided rows (CHECK).
- **`RecordConflictAcknowledged`** (new) records a clinician acknowledging or resolving a conflict.
- **Dose, frequency and unit are optional in the fact schemas,** so an incomplete fact reaches the person flagged (one band lower) instead of being dropped.
- **Nine languages** include Malayalam (the table in §10.1 names eight).
- **Page images are not re-rendered:** a PDF page is copied into its own single-page PDF; an image upload is its own page. Orientation and resolution normalization need an image library the repository doesn't carry. *Superseded in Week 4b (§15.3).*
- **The "no known allergies" conflict rule has nothing to read:** the schema has no verified NKDA record. *Superseded in Week 4b (§15.3).*
- **Proxy review** stays out of Week 4a, as §9 says: routes resolve only the session's own Person.

### 15.2 Decisions taken while building

- **Claude runs only with both `ANTHROPIC_API_KEY` and `DOCUMENT_AI_PROVIDER=claude`.** A key set for other features never turns the pipeline on.
- **A processing permit** (issued only by the real-data gate) is required by every provider call; a missing or forged one is refused.
- **The person's identifiers are masked before any provider sees text:** display name, contacts, linked records' names, UHIDs and phones, and any ABHA- or mobile-shaped number.
- **ID-proof uploads are never processed.**
- **A fact whose exact-copy check failed can't be confirmed as extracted;** the person corrects it to what the page says, or rejects it.
- **Bulk review is all or nothing.**
- **Exact fields must occur as whole tokens** ("11" does not occur in "11.2").
- **Dates on documents are read day-first** (`dd/mm/yyyy`, the Indian convention) or ISO; anything else is no date.
- **A patient-reported allergy without a severity is bridged with no severity** and criticality `UNABLE_TO_ASSESS`; the prescribing check treats it as a danger. A withdrawn one is replaced by the prompt "Allergy information withdrawn by the patient — ask about allergies".
- **A closed account's bridged allergies are taken back** (and again at purge), keeping clinician-confirmed ones.
- **Stalled steps are resumed by the runner:** a crashing step gives its claim back; a killed worker's claim goes stale after 10 minutes and the tick's sweep resumes it.
- **The timeline shows confirmed entries** ("Lab result from the patient's document: …", with "handwritten" where it applies) under the same rule as the uploads they came from. The RAG index hooks (§12 step 9) wait for Week 4b, which builds the index.

### 15.3 Week 4b follow-ups (2026-10-18)

- **Image pages are normalized before OCR** (`src/lib/documents/normalize.ts`, with `sharp`): the EXIF orientation is applied and then all metadata dropped (no camera, time or GPS tags reach storage or a provider); a tilt of up to ±10° is measured from the text lines' projection profile and undone, only when the measurement is clear; the long edge comes down to 2,400 px (never enlarged); the page is stored as JPEG (mozjpeg, quality 82). The upload itself is never touched; the normalized page is stored alongside it (`DocumentPage`, with a `normalization` record of what was done). A decompression bomb (over 80 megapixels) fails the run as `TOO_LARGE`; bytes that don't decode are `UNREADABLE`. Gate: `verify-postgres-image-normalization`.
- **Not done (where not feasible):** PDF pages are still not rasterized (no PDF renderer is carried; done in Week 4c, §15.4), and a page turned 90° or 180° with no EXIF tag is left to the OCR model, which reads rotated pages.
- **A record-level allergy status** (`AllergyStatusEntry`: `NO_KNOWN_ALLERGIES`, `UNKNOWN` or `HAS_ALLERGIES`, append-only history ordered by a per-patient sequence, event `AllergyStatusRecorded`):
  - no entry reads as `UNKNOWN` (or `HAS_ALLERGIES` while an allergy is active); "no known allergies" is never inferred, and no row was backfilled;
  - a clinician records `NO_KNOWN_ALLERGIES` or `UNKNOWN` only while no allergy is active (a shared patient-reported one counts); recording an allergy makes the status `HAS_ALLERGIES`; inactivating the last one makes it `UNKNOWN`, never "no known allergies";
  - the prescribing check flags an `UNKNOWN` status as a warning ("ask about allergies"), so an empty allergy list is never read as "none";
  - **the "no known allergies" conflict rule is on:** a confirmed uploaded allergy conflicts with a facility record whose current status is "no known allergies" recorded after the document's date (or when the entry is undated), checked both when the entry is added and when the status is recorded; `RecordConflictDetected` v2 adds `AllergyStatusEntry` as the verified side. Pending clinical advisor, with the other conflict rules.
  - Gate: `verify-postgres-allergy-status`.
- **The pipeline reads all eleven app languages:** Odia (`or`, Orya) and Urdu (`ur`, Arabic script) join the nine (labels, language detection, the mock translator's glossary). An Odia or Urdu app language now gets translations instead of the original only. `DocumentTextExtracted` and `DocumentTranslated` move to v2 for the two new codes (v1 kept).
- **A multi-script renderer for the evaluation** (`src/lib/documents/fixtures/render.ts`): each synthetic report is drawn in its own script with open fonts only (Noto Sans for Latin, Devanagari, Bengali, Tamil, Telugu, Kannada, Malayalam, Gujarati and Odia; Noto Nastaliq Urdu; handwriting-style Kalam, Gurajada, Kavivanar and Atma; all SIL OFL, in `assets/fonts`), shaped by Pango and HarfBuzz through a private fontconfig that sees only those fonts. Seeded noise: page tilt, blur, a shadow, speckle, a stamp and a folded corner; handwritten pages add blue ink and per-line tilt. A unit test proves every character of every sample has a glyph in its fonts, every language renders, and the output is deterministic. The marker PDFs stay the CI mock's input; the eval takes `rendered-image` (rendered, then normalized as a phone photo is) for the real run.
- **The 50-sample set covers the eleven languages:** `lab-or-thyroid`, `img-or-ct` (Odia), `rx-ur-1` and `dc-ur-1` (Urdu) replace `lab-bn-thyroid`, `img-en-ct`, `rx-gu-2` and `dc-en-3`; the category counts (15, 8, 10, 7, 5, 5) are unchanged.
- **Deskew uses a local threshold** (ink must be darker than its own neighbourhood), found while testing on the rendered photos: a global threshold counted the dark background around a photographed page and the shadow as ink. On the 50 noisy renders the correction is within 0.15° of the applied tilt.
- **`npm run eval:documents:real`** (manual, never in CI): the 50 samples, rendered and normalized, through the Claude providers; synthetic fixtures only (no Person, no database), refused while `AI_REAL_DATA_ENABLED=true`; the key read from the environment or `.env.local`, never printed; one content-free preflight request first, so a refused account sends nothing else; results (scores, models, tokens, latency) to `.eval-report/`. The scorer keeps exact fields byte-for-byte strict, compares the other fields for meaning (dates as dates, numbers as numbers), and falls back to the closest source line when a real model spans a line differently.
- **Bug fixed:** the Claude adapter read every HTTP 400 on an OCR call as `UNREADABLE`, a permanent failure. A billing refusal ("credit balance is too low") is a 400, so an account out of credit would have failed every upload for good ("We couldn't read this document"). It is now `PROVIDER_UNAVAILABLE` (retried); other 400s are unchanged. Found by the first real run, which the provider refused for that reason.

### 15.4 Week 4c: scanned and mixed PDFs (2026-10-19)

- **Each PDF page's own text layer is read first** (`src/lib/documents/pdfPages.ts`, pdf.js `pdfjs-dist`, Apache-2.0; pinned). Items are grouped into lines by baseline, ordered top to bottom and left to right, and given normalized boxes; abutting runs are joined without a space. The micro sign, which pdf.js returns as Greek mu, is put back where it prefixes a unit (µL, µg), so values copy exactly.
- **The verdict on a page's layer:**
  - `USABLE`: the layer is the page's text. It's stored as `ExtractedText` with provider `pdf-text-layer`, confidence 0.99, not handwritten. No provider sees the page.
  - `EMPTY`: fewer than 20 letters or digits (a scan, perhaps with a stray page number).
  - `GARBAGE`: more than 3% replacement, private-use or control characters; three or more mojibake sequences; or under 85% letters, digits, spaces and ordinary punctuation (a broken font encoding).
  - An `EMPTY` or `GARBAGE` page is rasterized and OCR'd. A layer that fails to parse is treated as `EMPTY`.
- **Rasterizing:**
  - **Rendering:** the page is rendered with pdf.js on `@napi-rs/canvas`. That's a prebuilt native addon, so no system binaries are needed, locally or in CI. mupdf was not used because of its AGPL licence.
  - **Normalization:** the long edge is about 2,400 px and the background white. The image is then normalized exactly as a photo is (§15.3).
  - **Storage:** the raster is stored alongside the page's single-page PDF (`DocumentPage.rasterRef`, `rasterSha256`, the `normalization` record), with the verdict in `DocumentPage.textLayer`.
  - **What OCR receives:** the raster, as `image/jpeg`. It also gets `sourcePdf`, the single-page PDF the image was rendered from. The Claude adapter reads only the image; the CI mock reads its fixture marker from `sourcePdf`.
  - **Labels:** page split records `pdf-lib+pdf.js` when any page was rasterized. The OCR step names the OCR provider if any page went to it, else `pdf-text-layer`.
- **What doesn't change:** the upload and its single-page PDFs are never modified. The patient's page view still shows the single-page PDF as the original.
- **Migration `20261023100000_pdf_text_layer`, additive:** three nullable columns and an enum. Pages split earlier keep `NULL` and are OCR'd as before; nothing is guessed for them.
- **The fixture PDFs are now scan-like:** grey bars where the lines are and no text layer. As a result, CI exercises the rasterize-and-OCR path on every fixture upload. `fixturePdf(f, { textLayer: true })` builds a digital page; `{ garbageTextLayer: true }` builds a mis-encoded one.
- **Gate `verify-postgres-scanned-pdf`:**
  - a scanned-only PDF and a mixed PDF (page 1 digital, page 2 scanned; only page 2 goes to OCR, and facts come from both, exactly);
  - a digital-only PDF, which makes no OCR call;
  - a garbage text layer;
  - an unopenable PDF;
  - redelivery;
  - the purge removing page objects and rasters.

  The image-normalization gate's PDF check now expects a raster.
- **Bug fixed:** the account purge deleted each upload's bytes but not the pipeline's derived objects in storage (single-page PDFs and normalized page images), which then stayed behind. These are now deleted after the rows, including the rasters. Gate: `verify-postgres-scanned-pdf`.

### 15.5 Week 4c: the documents page and browser smoke tests (2026-10-19)

- **"My documents" in the patient portal** (`/patient/documents`). Until now, upload, processing and review existed as APIs only. The page lets the person:
  - add a report (the existing upload route);
  - watch its run;
  - review what was found. Confirm-all appears only for high-confidence printed lines whose exact-copy check passed; other lines are confirmed or rejected one by one, and the server enforces both rules.

  Confirmed entries already appear on the record timeline (`buildPatientTimeline`, "Lab result from the patient's document: …"). Explain-my-report for an upload stays on the Reports page.
- **The doctor's visit-code consult** (`/consult/[sessionId]`) shows the AI panel (visit brief, chart Q&A) over what the code shares. The server already supported this path (`shareId`, RAG §16), but no page offered it.
- **`npm run e2e:smoke`** (`scripts/e2e-smoke.ts`, Playwright 1.62 with Chromium; CI job "Browser smoke"):
  - **Patient:** sign in → upload a scan-like sample report → it is rasterized, read and extracted on the mock providers by the real worker → review and confirm → the timeline shows the entry → explain my report, with the AI label, cited lines and sources.
  - **Doctor:** sign in → open the consult a redeemed visit code opened (with an appointment today) → visit brief → a cited line about the shared result, labelled "verified", and the sources list.
  - **Where it runs:** on a local database only, with the same refusals as verify:all (`scripts/lib/verifyTarget.ts`). It is never reset: migrations are applied, the seed runs only if missing, and fixtures are synthetic and tagged per run.
  - **Isolation:** no provider key reaches the app or the worker.
- **Bug fixed (privacy, from 4a):** a family delegate's view of the record (`/api/patient/records`, with a RECORDS grant) included the person's own uploads and patient-provided entries on its timeline. The reports list already kept them to the person's own login ("delegates see them from households, 5b"). The timeline now takes a `PROXY` viewer for a delegate's view, which carries none of the person's own uploads or entries until households define proxy permissions. Gate: `verify-postgres-person-leaks` (a delegate-view check, with B's own view as the positive control).
