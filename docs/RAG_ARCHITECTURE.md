# RAG architecture: the intelligence layer across Aarogya

- **Status:** Proposed (Phase 0, 2026-11-17). Nothing here is built until its phase in [`RAG_IMPLEMENTATION_PLAN.md`](RAG_IMPLEMENTATION_PLAN.md).
- **Builds on:** [`RAG_DESIGN.md`](RAG_DESIGN.md) (Week 4b, built), [`DOCUMENT_PIPELINE_DESIGN.md`](DOCUMENT_PIPELINE_DESIGN.md) (4a), [`CONSENT_SHARING_DESIGN.md`](CONSENT_SHARING_DESIGN.md) (4c), ADRs 0001–0004.
- **Decisions it depends on:** [`adr/0005-rag-embeddings-providers-and-tables.md`](adr/0005-rag-embeddings-providers-and-tables.md).
- **Findings it answers:** [`RAG_AUDIT.md`](RAG_AUDIT.md). **Threats:** [`RAG_THREAT_MODEL.md`](RAG_THREAT_MODEL.md).

## Contents

1. Principles
2. The shape of the system
3. The gateway
4. The three knowledge scopes and the two access worlds
5. Query understanding
6. The four retrieval channels
7. Fusion, ranking and context
8. Knowledge documents: model and ingestion
9. Embeddings
10. Languages
11. Token economy
12. Models, tiers and the provider data policy
13. Provenance, citations and clinical safety
14. Caching
15. Observability and administration
16. API surface
17. What is deliberately not built

---

## 1. Principles

These restate the rules this design must keep. Where the specification and the Aarogya rules disagree, the Aarogya rules win.

1. **Extend what exists.** `POST /api/ai/ask`, `askAi()`, the index tables, the embedding spaces, the access resolver and the gates stay. New tables only where ADR 0005 justifies them.
2. **Access is decided in SQL, before ranking,** from server-side values only. Nothing is retrieved and filtered afterwards.
3. **The database is the source of truth.** A fact that a query can answer exactly is never answered from an embedding.
4. **The index is derived data.** It can always be rebuilt, is never the only copy, and is hard-deleted.
5. **Every answer cites.** A sentence the sources don't support is not shown. "No record found" is a valid answer.
6. **Nothing is written to the record by the AI.** No note, order, prescription or status change.
7. **Synthetic data only.** `AI_REAL_DATA_ENABLED` stays off. Every provider call needs a permit.
8. **No protected health information leaves for an external provider** unless that provider's own policy flag allows it. The default is off for every provider.
9. **Scholar never touches hospital or person data,** in either direction.
10. **One Postgres.** No Redis, queue broker, vector database, framework or new service.
11. **Everything builds and passes on deterministic mocks.**

## 2. The shape of the system

```
 Doctor workspace   Nursing OS   Patient portal   Command centre   Admin
        │               │              │                │            │
        └───────────────┴──────┬───────┴────────────────┴────────────┘
                               ▼
                    POST /api/ai/ask   (the only entry point)
                               │
        ┌──────────────────────▼──────────────────────────┐
        │  GATEWAY  (askAi, extended)                     │
        │  1 session and actor      5 retrieval plan      │
        │  2 rate limits and budget 6 context and tokens  │
        │  3 access scope (SQL)     7 provider by policy  │
        │  4 safety rules, intent   8 validate, label, log│
        └───┬───────────┬───────────┬───────────┬─────────┘
            ▼           ▼           ▼           ▼
       Structured    Semantic    Full text   Operational
       readers       (pgvector)  (tsvector,  readers
       (services)                 pg_trgm)   (services)
            │           │           │           │
            └───────────┴─────┬─────┴───────────┘
                              ▼
     PostgreSQL: the record · RagDocument / RagChunk / RagEmbedding
                 KnowledgeDocument(+Version) · AiInteraction(+Source)

 Writers of the index (never the request path):
   record events ──► rag-indexer ──► index           (exists)
   4a pipeline ──► confirmed facts ──► rag-indexer   (exists)
   knowledge upload ──► knowledge-ingest (bulk lane) ──► index   (new)
```

Two properties hold everywhere in this picture:

- **The request path only reads.** Indexing happens in consumers, driven by the transactional outbox.
- **A provider is reached only through `src/lib/ai`,** with a permit issued by the real-data gate.

## 3. The gateway

The gateway is `askAi()` in `src/lib/rag/ask.ts`, extended. It is a service function. The route handler stays thin.

### 3.1 Order of work

The order is the security design. Each step runs only if the one before it allowed the request.

| # | Step | Exists | Notes |
|---|---|---|---|
| 1 | Session and actor | Yes | Role and facility from the database, never the request. |
| 2 | Rate limits and the facility budget | Yes | Counted on `AiInteraction`, so they hold across instances. A token budget per facility is added. |
| 3 | Access scope | Yes | `resolveAiAccess()` for a patient; a new resolver for knowledge and operational requests (§4). 403 for a mode the caller can't use, 404 for a record they can't see. |
| 4 | Safety rules, then intent | Partly | Patient safety rules exist. The intent router is new (§5). Both run before anything is retrieved. |
| 5 | Retrieval plan | Partly | Which channels run, in what order, with what limits (§6). |
| 6 | Context and token budget | New | Deduplicate, order, trim to the budget (§11). |
| 7 | Provider by tier and policy | Partly | Tier 0 answers without a model (§12). |
| 8 | Validate, label, log | Yes | Citations, numbers, labels, `AiInteraction`. Medicine names and units join the validation. |

### 3.2 What the request may say

The request names a mode and, where the mode needs them, a patient, a share, a report, an appointment, a question, a period and a language. That is all. The organisation, facility, role, access path, categories, model and provider always come from the server.

### 3.3 What changes at the edges

- **`/api/chat` (the portal assistant)** keeps its URL. A general question with no record is answered as today. A question about a record is passed to the gateway and answered under its rules, or refused. Until that is built, `/api/chat` refuses any REAL facility or person (the first step of Phase 1).
- **Scholar routes** (`/api/student/*`) are unchanged and stay on their own provider family.

## 4. The three knowledge scopes and the two access worlds

### 4.1 Scopes

Every indexed row belongs to exactly one scope, set at write time and enforced by a CHECK.

| Scope | Owner type | What it holds | Who may retrieve it |
|---|---|---|---|
| Patient record | `FACILITY_PATIENT` (exists) | A facility's verified entries about one patient | Staff with access to that patient; the patient; a proxy |
| Person | `PERSON` (exists) | A person's uploads and confirmed patient-provided facts | The person; a proxy; staff only with the person's choice |
| Knowledge | `KNOWLEDGE` (new) | Approved SOPs, policies and references, with no patient in them | Staff of the organisation or facility, by access class |

A fourth, **Scholar knowledge**, is kept apart: synthetic teaching material, retrievable only by Scholar roles, in rows that carry no organisation, facility, patient or person. A CHECK enforces that. No query ever names both a Scholar scope and another.

### 4.2 The two access worlds

Both are applied inside the SQL that selects candidates.

**Hospital staff:**

- the role's permission (`ai:record:ask`, `ai:knowledge:ask`, `ai:ops:ask`);
- the caller's organisation and facility, from the staff profile;
- for a patient: an active care relationship (doctors), an open nursing assignment (nurses), a share, or the patient's consent to the organisation;
- for knowledge: the document's organisation, its facility or "all facilities of the organisation", and its access class against the caller's role.

**Person-level data:**

- the person access resolver, `personAccess()`;
- `PersonConsent` (the upload-sharing choice, AI assistance, AI text retention);
- the share's categories: sensitive categories are excluded unless the share opted them in, and allergies are always included;
- the care-relationship windows for OPD and IPD;
- household proxy rights (`USE_AI`, and the grant's categories);
- the per-person AI consent: AI over a person's record without it answers 404, exactly as today.

### 4.3 The scope as data

`RetrievalScope` (`src/lib/rag/scope.ts`) is a list of segments. A chunk is a candidate only if one segment admits it. A knowledge segment is added:

```ts
interface KnowledgeSegment {
  path: "KNOWLEDGE";
  organizationId: string;
  /** The caller's facility; organisation-wide documents (facilityId null) are admitted too. */
  facilityId: string;
  /** Access classes the caller's role may read. */
  accessClasses: KnowledgeAccessClass[];
  /** Only versions in force now: published, effective, not expired, not superseded. */
  inForceAt: Date;
  documentTypes?: KnowledgeDocumentType[];
}
```

**A request carries patient segments or knowledge segments, never both in one candidate query.** A mode that needs both (a doctor asking how the sepsis protocol applies to this patient) runs two queries and merges their results after each was filtered by its own scope. This keeps each SQL predicate small enough to review and to test with canaries.

## 5. Query understanding

### 5.1 The mode is the first classifier

The caller already says what they want by choosing a mode. The six modes stay. Three are added:

| Mode | Who | Scope | Output |
|---|---|---|---|
| `KNOWLEDGE_QA` | Staff with `ai:knowledge:ask` | Knowledge | A cited answer from approved documents in force |
| `OPS_QA` | Staff with `ai:ops:ask` and the permission of each reader used | Operational readers | A templated, cited answer. Tier 0: no model unless synthesis is needed |
| `CHART_QA` with knowledge | Doctors | Patient, then knowledge | A chart answer that may also cite a protocol, each source labelled by kind |

Billing, pharmacy and administrative questions are not modes of their own. They are intents inside `OPS_QA` and `KNOWLEDGE_QA`, each behind the permission its own screen already needs.

### 5.2 The intent router (deterministic)

Inside a mode, a router decides which channels to run. It is rules over the question's words, using vocabularies the code already has (the analyte and unit lists in `documents/protect.ts`, the medicine reference, a small table of clinical abbreviations).

It returns a typed plan:

```ts
interface RetrievalPlan {
  intent: "STRUCTURED_LOOKUP" | "NARRATIVE" | "MIXED" | "KNOWLEDGE" | "OPERATIONAL" | "UNSUPPORTED";
  entities: { analyte?: string; medicine?: string; period?: { from?: Date; to?: Date }; documentType?: string; latest: boolean };
  readers: StructuredReaderId[];      // channel 1 and 4
  semantic: boolean;                  // channel 2
  keyword: boolean;                   // channel 3
  risk: "LOW" | "CLINICAL" | "HIGH_RISK";
  confidence: "RULE" | "DEFAULT";
}
```

- **`RULE`**: a rule matched. "Latest haemoglobin" is a structured lookup for the analyte Haemoglobin, newest first.
- **`DEFAULT`**: no rule matched. The plan is the full hybrid retrieval, which is what every question gets today. So the router can only make a request cheaper or more exact. It cannot make it less safe than the current behaviour.

**No model is used to classify.** A model-based classifier is considered only if the evaluation shows a class of question the rules route wrongly, and then only on the cheapest tier.

### 5.3 Entities never come from the client as authority

A patient id in the body is a request, checked by the access resolver. An extracted medicine or analyte only narrows a query. Nothing extracted from the question can widen the scope.

## 6. The four retrieval channels

### 6.1 Channel 1: structured readers

A registry of small readers over the existing service layer. Each returns facts in the same shape as today's live facts: a stable id (`live:<kind>:<id>`), a context line, a text, an origin and a date. So the generator, the validator and the citations need no change.

| Reader | Source | Category it needs |
|---|---|---|
| Active medicines; doses due or missed (nurse) | Medication orders, the MAR | `PRESCRIPTIONS` (exists) |
| Active allergies; the allergy status | Allergies | `ALLERGIES` (exists) |
| Latest vitals | Vitals | `VITALS` |
| Latest and trend of one analyte | Released lab results | `LABS` |
| Pending lab and imaging orders | Orders | `LABS`, `IMAGING` |
| Current encounter and bed | Encounters, ADT | Treating staff only |
| Problems and diagnoses | Problem list, diagnoses | `DIAGNOSES` |

Rules for every reader:

- it takes the resolved access object, never ids from the request;
- it reads only the records and categories the access path allows, and applies the share's period;
- it is bounded (a `take`), ordered, and explicit about its date range;
- a sensitive item follows the scope's opt-ins, as the medicine and allergy readers already do;
- **an absent row is "not recorded", never "none".** No allergy rows does not mean no allergies; the allergy status says which it is.

### 6.2 Channel 2: semantic

Unchanged for patients: exact cosine distance over the active embedding space, filtered on the embedding row.

For knowledge, the same query with the knowledge segment. An organisation's corpus is expected to be far smaller than the 20,000 chunks the latency gate already covers. If a corpus outgrows the budget, an HNSW index over one embedding space is added by migration; nothing in the design depends on it.

### 6.3 Channel 3: full text

Three matchers, combined as one keyword rank:

| Matcher | Used for | Mechanism |
|---|---|---|
| Exact and prefix, `simple` | Every language. Medicine names, codes, numbers. | The existing `tsv` column and OR query |
| English stems | Chunks whose language is English | A second generated column, `to_tsvector('english', …)`, only for English chunks |
| Trigram word similarity | Indic inflection, transliterated spellings, typing errors | `pg_trgm`, with a threshold from the evaluation |

An abbreviation table (BP, FBS, HbA1c, TDS, and the local ones) expands the query's terms. It adds terms. It never rewrites the question.

Section 10 covers what this does and does not do for Indic languages.

### 6.4 Channel 4: operational readers

Live state is read from the service that owns it, every time.

| Reader | Service | Permission |
|---|---|---|
| Bed availability and occupancy | `hospital/bed.ts`, `commandCenter.ts` | The command centre's own |
| Queue status | `hospital/queue.ts` | The queue screen's own |
| Pending tasks | `workflows/` | The task list's own |
| Pharmacy stock, procurement | `hospital/pharmacy.ts`, `inventory/`, `procurement/` | The pharmacy and inventory screens' own |
| Admissions and discharges; discharge barriers | `hospital/admission.ts`, `dischargeBarrierEngine.ts` | The ADT screens' own |
| Billing status | `billing/` | The billing screens' own |
| Unacknowledged critical results | `hospital/alertEngine.ts` | The results screens' own |

Rules:

- **Counts and states by default.** A reader names a patient only when the caller holds the permission that the screen showing that name needs.
- **Never embedded, never cached.** An operational answer states the time it was read.
- **Tier 0 first.** A count is a templated sentence. A model is used only to combine several readers' results, and then it sees only those results.

## 7. Fusion, ranking and context

### 7.1 Candidates

Starting values, all in the config registry, tuned by the evaluation:

| Setting | Today (code) | Spec's starting value | Plan |
|---|---|---|---|
| Vector candidates | 40 | 30 | Measure both; keep the better |
| Keyword candidates | 40 | 30 | The same |
| Fused, sent to rerank | 30 | 20 | The same |
| Kept | 8 (12 for the brief, handoff, timeline) | 5–8 | The same |

### 7.2 Ranking

1. **Fusion:** reciprocal-rank fusion (k = 60) over the vector rank and the keyword rank. Unchanged.
2. **Rerank:** the embedding space's reranker over the fused top. Skipped when a structured reader fully answered the question.
3. **Adjustments, each small and each measured:**
   - "latest", "last", "current" favour the newest (exists);
   - `VERIFIED` above `IMPORTED` above `PATIENT_PROVIDED` on the same footing;
   - for knowledge: a facility's own document above an organisation-wide one on the same subject; a document type's authority (a policy above a guideline note).
4. **Ties:** the newer, then the chunk id, so results are deterministic.

**A score is never shown as confidence** and never treated as clinical truth. It decides only order and the "no record" threshold.

### 7.3 Versions

Only a version that is published, effective, not expired and not superseded is a candidate. This is a filter in SQL, not a ranking penalty, so a superseded protocol cannot outrank the current one by being a closer match.

### 7.4 Building the context

1. **Structured facts first.** Where a reader and a chunk state the same fact, the reader's value is used and the chunk is dropped.
2. **Deduplicate passages** by a hash of the normalised text.
3. **Neighbours:** when a kept chunk ends mid-section, `chunkNo ± 1` of the same document is added, inside the same scope filter.
4. **Order:** by the mode (the timeline oldest first; a question by rank).
5. **Trim to the token budget** from the lowest rank, never cutting inside a chunk and never dropping a structured fact.
6. **Mask identifiers** (exists): no name, UHID, phone, address or ABHA number reaches a provider.

## 8. Knowledge documents: model and ingestion

### 8.1 Model (new; ADR 0005 part B)

**`KnowledgeDocument`**: the identity of a document across its versions.

- organisation; facility, or null for the whole organisation;
- type (`SOP`, `POLICY`, `CLINICAL_REFERENCE`, `FORMULARY`, `ADMIN`, `EDUCATIONAL`);
- access class (`ALL_STAFF`, `CLINICAL`, `PHARMACY`, `BILLING`, `ADMIN`), which roles map onto;
- title, description, owner, current version.

**`KnowledgeDocumentVersion`**: one uploaded file.

- version number; storage reference; sha-256 of the bytes; content type; language;
- uploader; uploaded at;
- approval status (`DRAFT`, `SUBMITTED`, `APPROVED`, `REJECTED`), approver, approved at;
- effective at; expires at; superseded by;
- ingestion status (`RECEIVED`, `PARSING`, `CHUNKING`, `EMBEDDING`, `INDEXED`, `FAILED`), attempts, a closed error code, the scan status (`NOT_SCANNED` until a scanner exists).

**The chunks and vectors go in the existing `RagDocument`, `RagChunk` and `RagEmbedding`,** with `ownerType = KNOWLEDGE`. There is no `KnowledgeChunk` table.

### 8.2 Who may do what

| Action | Permission |
|---|---|
| Upload a draft version | `ai:knowledge:manage` |
| Approve and publish | `ai:knowledge:approve`, and never the uploader of that version |
| Ask | `ai:knowledge:ask`, limited by access class |
| Withdraw | `ai:knowledge:manage` |

Two people are needed to publish. A document that every clinician's assistant will quote should not be one person's upload.

### 8.3 Pipeline

Background work uses the transactional outbox, `runTick` and the bulk lane. No new job system.

```
upload (API)                      ── tx: version row RECEIVED + KnowledgeDocumentVersionUploaded
   ▼
knowledge-ingest consumer (bulk lane)
   parse → detect language → classify → sections → normalise → chunk
   ── tx: status + KnowledgeDocumentVersionParsed
   ▼
embed (outside any transaction; permit for non-PHI knowledge)
   ── tx: RagDocument/RagChunk/RagEmbedding written with status PENDING
          + KnowledgeDocumentVersionIndexed
   ▼
approve (API, a second person)    ── tx: APPROVED + KnowledgeDocumentVersionApproved
   ▼
publish at effectiveAt (runner)   ── tx: this version's chunks ACTIVE,
                                        the previous version's SUPERSEDED,
                                        + KnowledgeDocumentVersionPublished
```

The pipeline's steps, against the spec's nineteen:

| Spec step | Here |
|---|---|
| Receive, authenticate, validate type and size | The upload route; `storage/validation.ts` (exists) |
| Malware scan | An adapter slot. Until a scanner is procured the status is `NOT_SCANNED` and the admin view says so. It never claims to have scanned. |
| Content hash, duplicate detection | sha-256 of the bytes. The same bytes for the same document are refused as a duplicate; the same bytes under another document reuse the parsed chunks and vectors. |
| Extract text | PDF through `pdfjs-dist` (present); plain text, Markdown, HTML, CSV and JSON with no new dependency; DOCX waits for a decision |
| OCR | The 4a `VisionOcrProvider`, with a knowledge permit, only for image-only pages |
| Language, type | `documents/language.ts` (exists); the type is chosen by the uploader and checked by rules |
| Sections, normalise, noise | New, pure functions with golden tests |
| Chunk | `chunk.ts`, extended for tables and page references |
| Embed, store | `rag/embed.ts` (exists) |
| Status, events | On the version row; one catalogued event per state change, in the same transaction |

### 8.4 Guarantees

- **Idempotent.** A replayed event finds the same version and hash and does nothing.
- **Never half-indexed.** Chunks are written `PENDING` and become `ACTIVE` only at publish, in one transaction. Retrieval filters on `ACTIVE`.
- **Retryable.** A provider failure is a retry with backoff; a file that cannot be parsed is `FAILED` with a closed code, visible in the admin view, and can be re-run.
- **Old versions stay traceable.** A superseded version keeps its row, its file and its `RagDocument` row (status `SUPERSEDED`). Its chunks are deleted, as for patient sources. A citation to it still resolves through `AiInteractionSource`.
- **No patient data.** A knowledge document must not contain patient identifiers, because a knowledge row is readable by a whole facility. Ingestion extends the existing identifier detector (ABHA- and mobile-shaped today) with UHID- and Aadhaar-shaped patterns, and refuses a file with an ABHA-, UHID- or Aadhaar-shaped number (`CONTAINS_IDENTIFIERS`). A phone number alone is flagged for the approver, since a protocol may list helplines.

### 8.5 The 4a pipeline is not duplicated

| | 4a (patient uploads) | Knowledge ingestion |
|---|---|---|
| Owner | A person | An organisation or facility |
| Facts | Extracted, then confirmed by the patient | None extracted; the text is the content |
| Translation | Yes, with exact-copy protection | No; the original language is indexed |
| Reaches the index | As confirmed `PatientProvidedRecord`s, through the `rag-indexer` | As chunks of the document |
| Shared code | OCR provider, PDF pages, language detection, identifier detection, storage | The same |

## 9. Embeddings

The mechanism exists and is kept: `EmbeddingProvider`, chosen by the embedding space; one `ACTIVE` space; a re-embed job that needs 100% coverage to switch; model and version on every vector; no mixing of models in one search, because every query names one space.

**Which model** is ADR 0005's subject. Its position in one line: nothing is adopted in Phase 0; the mock stays active; Phase 1 builds an Indic retrieval benchmark, and a model is adopted only on its numbers.

Additions:

- **A content-hash cache** inside one embedding space, for knowledge text, so a re-uploaded or lightly edited document re-embeds only its changed chunks.
- **Usage:** embedding tokens and rerank units are recorded per request and per ingestion run.
- **A knowledge permit.** Embedding a knowledge chunk involves no person, so it needs its own permit kind. It is issued only for a version that passed the identifier check.

## 10. Languages

The app has eleven languages: English, Hindi, Bengali, Marathi, Telugu, Tamil, Gujarati, Urdu (right to left), Kannada, Odia and Malayalam.

### 10.1 What PostgreSQL gives, stated honestly

PostgreSQL ships no text-search dictionary for Hindi or any other Indic language. There is no stemming, no stop-word list and no script conversion for them. The measurements are in `RAG_AUDIT.md` §11.

| Need | English | Indic scripts | Transliterated (Latin) Indic |
|---|---|---|---|
| Whole-word match | `english` and `simple` | `simple` (measured: correct for all ten) | `simple` |
| Inflected forms | `english` stems, plus prefix | **No stemming.** `pg_trgm` word similarity (measured 0.75–0.86 for true variants) | `pg_trgm` (0.50–0.89) |
| Spelling variants | `pg_trgm` | `pg_trgm` | `pg_trgm` |
| Stop words | `english` | **None.** Common particles are matched like any word; the rank absorbs it | None |
| Latin query, Indic text (or the reverse) | — | **Not possible in PostgreSQL** (measured 0.00) | — |

### 10.2 The cross-script gap

A doctor types "metformin"; the uploaded prescription says "मेटफॉर्मिन". No keyword matcher bridges that. Two things can:

1. **A multilingual embedding model.** This is the main reason the embedding decision matters, and the benchmark in ADR 0005 measures exactly this case.
2. **Canonical names as extra index terms.** At index time, a medicine name found in any script is looked up in the medicine reference (NLEM, WHO INN) and its international name is added to the chunk's keyword terms. The chunk's text is never changed. This works with the mock and gives exact medicine lookup across scripts.

Until a real multilingual model is benchmarked, cross-script retrieval beyond medicine names is **not claimed**. The evaluation reports it as its own line.

### 10.3 Rules that hold in every language

- **Medicine names, doses, units, numbers and dates are never translated or paraphrased.** They are quoted from the original. The validator checks every number, and (new) every medicine name and unit, against the cited source.
- **The answer is in the user's app language.** The citation points to the source in its original language, and the line carries the `translated` label.
- **Urdu is right to left.** The answer panel sets the direction per line. Numbers, units and Latin medicine names stay left to right inside it. This is checked in the browser run for mobile.
- **Fixed phrases** (the advisory label, "no record found", "please ask your care team") come from the phrasebook in eleven languages, never from a model.

## 11. Token economy

### 11.1 Budget

Each request gets a budget before any provider is called:

```
budget(mode, model) = context window of the model
                    − system instructions
                    − tool or output schema
                    − question
                    − output allowance (from the mode's word limit)
                    − a safety margin
                    = tokens available for sources
```

- Budgets are per mode and per model, in the config registry.
- **Tokens are estimated before the call and measured after it.** The provider's reported usage is recorded and the estimate's error is tracked per language. The estimator is corrected from that data; Indic scripts are known to be undercounted today.
- A request that cannot fit even its structured facts is refused, not truncated silently.

### 11.2 Selection

Fewer tokens come first from sending less, in this order:

1. a structured reader answered: no retrieval, no rerank, often no model (Tier 0);
2. "no record" decided before the model (exists);
3. duplicates and repeated facts removed (§7.4);
4. the lowest-ranked chunks dropped to fit.

### 11.3 Compression

**Level 1, deterministic (built):** collapse whitespace; drop repeated headers and footers; drop the metadata the context line already states; compact structured rows.

It must be lossless for clinical content. A property test asserts that every number, unit, date, medicine name, dose, route, frequency and negation in the input is in the output.

**Level 2, by a model (not built unless measured):** only if the evaluation shows a mode that cannot fit its budget after level 1. If built, its output is never the sole evidence: the original chunk stays the citation, and the validator checks against the original.

### 11.4 Conversation memory

Every request is single-shot today. Whether to add conversations is open question 5, because stored turns are retained patient text. The design, if approved:

- the current question, plus at most the last few turns that the router marks as referenced;
- a turn's stored text follows the existing retention rule: staff text encrypted for at most 90 days; patient text only under the `AI_TEXT_RETENTION` opt-in;
- **memory never overrides the record.** Each turn re-runs access and retrieval; a past answer is context for the wording of the question, never a source.

### 11.5 Accounting

Recorded per request on `AiInteraction`: input and output tokens, embedding tokens, rerank units, provider, model, tier, estimated cost, cache hits, retrieval and generation latency, module and intent. Reported by organisation, facility, role, module, model and request type. Per-user figures are for the administrator of that facility only.

Cost is an estimate from a price table in the config registry, dated. Usage is never reported as zero; a Tier 0 answer records zero model tokens and its real retrieval cost.

## 12. Models, tiers and the provider data policy

### 12.1 Tiers

| Tier | What | Used for |
|---|---|---|
| 0 | No model: SQL, rules, templates | Structured lookups, operational counts, "no record", safety refusals |
| 1 | A small model | Short knowledge answers; the 4a helpers (exists) |
| 2 | A strong model | Record synthesis: brief, handoff, timeline, chart Q&A, every patient-facing mode |
| 3 | Restricted | Not defined. No workflow has asked for it. |

**A cheaper tier never lowers a safety requirement.** Patient-facing modes stay on Tier 2 (`RAG_DESIGN.md` §14). The validator, the labels and the refusal rules are the same on every tier.

### 12.2 Provider families

The three families stay separate (`RAG_AUDIT.md` §4.2 and §6.2). Routing is added inside the record-answer family: a registry of providers, each with its models, its capabilities and its data policy.

### 12.3 The data policy

Two conditions must both hold for real data to reach a provider:

1. the global switch, `AI_REAL_DATA_ENABLED` (exists; off);
2. **that provider's own flag,** `AI_PHI_ALLOWED_<PROVIDER>` (new; default off for every external provider), set only after its data-processing agreement and cross-border check are recorded in `PRE_LAUNCH_CHECKLIST.md`.

Enforced where the permit is checked, inside each provider, so no caller can skip it. Today's hard-coded Voyage refusal becomes this flag.

| Data | Mock | External provider, flag off | External provider, flag on |
|---|---|---|---|
| Synthetic | Yes | Yes | Yes |
| Knowledge documents (no identifiers) | Yes | Per the organisation's setting | Yes |
| Real patient or person data | **Refused** | **Refused** | Allowed, with the switch on and consent |

### 12.4 Failure

- A real provider's failure is a 503. It never falls back to the mock (exists).
- Failover to another provider is allowed only to one with the same or a stricter data policy and the same tier.

## 13. Provenance, citations and clinical safety

### 13.1 Labels

Every line of an answer shows where its facts came from.

| Label | Meaning | Counts as a verified clinical fact |
|---|---|---|
| `verified` | Issued or signed by a hospital in the system | Yes |
| `patient-provided` | Confirmed by the person or a proxy from an upload; not clinician-verified | **No** |
| `imported` (new) | Brought from the hospital's previous system; not verified here | **No** |
| `reference` (new) | From an approved knowledge document; not about this patient | Not applicable |
| `handwritten`, `translated`, `not yet confirmed by you` | As today | — |

Rules:

- Where a verified and a non-verified entry disagree, the answer gives the verified value, cites both and says they disagree (exists for patient-provided; extended to imported).
- An imported or patient-provided value is never the basis of a "latest" answer when a verified value exists for the same test.
- **A reference line never states a fact about the patient,** and a patient line never rests on a reference document.

### 13.2 The four kinds of statement

The specification asks the system to distinguish recorded facts, reference information, model interpretation and recommendations. Mapped onto the existing sentence kinds:

| Kind | In the answer | Rule |
|---|---|---|
| Recorded fact | `FACT`, citing record sources | Every number, unit and medicine name must be in a cited source |
| Reference information | `FACT`, citing knowledge sources, labelled `reference` | The same check, against the document |
| Interpretation | Not produced for patients. For staff, only as an ordering or summary of cited facts | No uncited sentence passes |
| Recommendation | Not produced | A fixed `GUIDANCE` line ("please ask your care team") |

### 13.3 What the AI never does

Unchanged from `RAG_DESIGN.md` §9, restated because the scope is wider now:

- invent a diagnosis, a dose or a value;
- treat an absent allergy record as "no allergies";
- present an old result as current (a result is always dated; "latest" comes from a reader);
- modify a signed note, issue a prescription, or change an order, admission or plan;
- diagnose or advise treatment for a patient or a proxy.

### 13.4 Citations that last

A citation today names a chunk id, and chunks are hard-deleted when their source is superseded. `AiInteractionSource` records, per cited or retrieved source: the source type and id, the document version, the page and section, the origin, the rank and whether it was cited. It holds no text. A reviewer can then see what an answer rested on a year later, and the UI can open the original only after access is checked again.

## 14. Caching

Caches live in Postgres or in per-request memory. There is no global patient-data cache.

| Layer | Built | Key | Why this is safe |
|---|---|---|---|
| Embedding of indexed content | Yes (exists per source; extended by content hash for knowledge) | Space, content hash | A vector depends only on the text and the model |
| Query embedding | Per request for patient modes; in Postgres for knowledge modes | Space, hash of the normalised question | A knowledge question names no patient. A patient-mode question may, so its vector is never stored |
| Retrieval results | **Not built for patient or person data.** Considered for knowledge only | Organisation, facility, access classes, in-force version set, space, question hash | Patient access changes on consent, share, proxy, link, assignment and care window; retrieval there takes about 60 ms, so a cache buys little and risks a leak |
| Response | **Not built for patient or person data.** Considered for knowledge only, after measurement | The retrieval key plus model, prompt version, language | A cached answer is revalidated against the current in-force version set before it is served |

Never cached anywhere: operational state (beds, queues, doses, stock), live facts, and anything read through a share.

Invalidation for the knowledge caches is by key, not by event: the key contains the set of version ids in force, so publishing or withdrawing any document changes the key.

## 15. Observability and administration

- **Per request:** `AiInteraction` (metadata only; text only under the retention rules).
- **Per ingestion:** the version row's status, attempts and error code; the outbox's own delivery records and dead letters.
- **Health view** (`GET /api/ai/admin/health`, platform admin): active embedding space and coverage; documents by ingestion status; failed versions; dead letters of the two consumers; provider availability; p50 and p95 of retrieval and generation; cache hit rates; citation-invalid and no-record rates.
- **Usage view** (`GET /api/ai/usage`): tokens and estimated cost by organisation, facility, role, module, model and request type.

**No view shows a prompt, an answer or a source's text.** Reading retained text stays what it is today: two reviewer roles, a reason code, a ticket, and an audited read.

## 16. API surface

| Route | Status | Permission |
|---|---|---|
| `POST /api/ai/ask` | Exists; gains modes | Per mode |
| `GET /api/ai/me` | Exists | Signed in |
| `GET /api/ai/interactions`, `…/report`, `POST …/:id/text` | Exist | Reviewer roles |
| `GET /api/ai/sources/:id` | New | Access re-checked for the caller, now |
| `POST /api/ai/knowledge`, `GET /api/ai/knowledge/:id`, `POST …/versions`, `POST …/versions/:v/approve`, `POST …/withdraw` | New | `ai:knowledge:manage`, `ai:knowledge:approve` |
| `GET /api/ai/usage` | New | `ai:usage:read` |
| `GET /api/ai/admin/health`, `POST /api/ai/admin/reindex` | New | Platform admin |
| `POST /api/chat` | Exists; record questions go through the gateway | Signed in |

Every response is `Cache-Control: no-store`, like every other API response (the cache-privacy gate checks it). No response carries a secret, a hash, a storage reference or a provider's raw error.

## 17. What is deliberately not built

| Not built | Why |
|---|---|
| `/api/ai/query` | `/api/ai/ask` already is the entry point |
| A model-based classifier | Modes and rules decide; measured need first |
| Semantic compression | Deterministic first; measured need first |
| Retrieval and response caches over patient data | Risk outweighs a saving of tens of milliseconds |
| Cross-patient search (cohorts) | A non-goal since Week 4; a different consent basis |
| Tools for the model (SQL, HTTP, shell) | The model has one output schema and nothing else |
| Writes by the AI | Principle 6 |
| A Tier 3 workflow | Nothing has asked for one |
| `KnowledgeChunk`, `EmbeddingJob`, `RAGQueryLog` tables | Existing tables are extended (ADR 0005) |
| A new job system, a vector database, Redis | Rule 6 |
