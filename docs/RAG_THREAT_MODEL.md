# RAG and AI layer: threat model

- **Status:** Phase 0 (2026-11-17). Covers the AI layer as built (Week 4b–5b) and as proposed in [`RAG_ARCHITECTURE.md`](RAG_ARCHITECTURE.md).
- **Scope:** `/api/ai/*`, `/api/chat`, `src/lib/rag`, `src/lib/ai`, the `rag-indexer`, the proposed knowledge ingestion, and every provider call they make.
- **Out of scope:** threats already covered by `HOSPITAL_THREAT_MODEL.md`, `STUDENT_PLATFORM_THREAT_MODEL.md`, `PATIENT_SECURITY.md` and `COMMAND_CENTER_SECURITY.md`, except where the AI layer changes them.
- **Convention:** as in the other threat models. Each threat has the concern, what stops it today, the gap, and the gate that will prove the mitigation. "Today" was read from the code in this audit, not assumed.

## Contents

1. Assets
2. Actors
3. Trust boundaries
4. Threats
5. Summary table
6. What blocks real data

---

## 1. Assets

| Asset | Where | Why it matters |
|---|---|---|
| The clinical record | The record's own tables | The source of truth; the AI only reads it |
| Person-owned data | `PersonDocument`, `PatientProvidedRecord` | Belongs to the person, shared only by their choice |
| The index | `RagDocument`, `RagChunk`, `RagEmbedding` | A second copy of clinical text, and vectors derived from it |
| Retained question and answer text | `AiInteraction` ciphertext | May name patients; encrypted; at most 90 days |
| Interaction metadata | `AiInteraction`, `AiInteractionSource` (proposed) | Shows who asked about whom |
| Knowledge documents | Proposed tables and storage | Confidential to the hospital; quoted to many staff |
| Prompts and safety rules | Code | Their disclosure helps an attacker shape an injection |
| Provider credentials | Environment only | Spend and data exposure |
| Scholar's synthetic cases | Scholar tables | Must stay free of real data |

## 2. Actors

| Actor | Can | Wants (as an adversary) |
|---|---|---|
| Staff at another facility or organisation | Sign in, call every route with their session | Another tenant's patients or documents |
| Staff at the right facility, wrong patient | The same | A patient they are not treating; a colleague's or their own record |
| A nurse | The same | A patient not assigned to them |
| A patient or proxy | Sign in; upload documents | Another person's record; a diagnosis the system must not give |
| A doctor with a share | Redeem a code | More than the share covers, or after it ends |
| A document author | Upload a patient document or a knowledge document | To make the model say or do something |
| A knowledge manager | Upload and submit documents | To publish an unapproved or harmful protocol |
| A Scholar user | Use Scholar | Real clinical data |
| A reviewer (clinical advisor, safety officer) | Read retained text with a reason | Text outside their remit |
| An external provider | Receive what is sent | — (must receive no real data without its flag) |
| An operator with database or log access | Read logs and tables | Clinical text in places it should not be |

## 3. Trust boundaries

1. **Browser to server.** Nothing from the browser is trusted for identity, role, facility, organisation, access path or model.
2. **Request path to database.** The scope is turned into SQL from server-side values. This is the main control.
3. **Server to provider.** Crossed only with a permit. What crosses is masked and minimised.
4. **Stored text to prompt.** Every retrieved passage is data written by someone else. It is never an instruction.
5. **Hospital world to Scholar world.** No row, no import and no query crosses.
6. **Person-owned to facility-owned.** Crossed only through the person access resolver.

## 4. Threats

Severity is the harm if the mitigation fails: **Critical** (patient data to the wrong party, or a harmful clinical statement), **High**, **Medium**, **Low**.

### T-R01: Cross-facility or cross-organisation retrieval (Critical)

**Concern.** A staff member retrieves another tenant's patient chunks or knowledge documents through vector search, keyword search, a structured reader, a citation or the sources route.

**Today.** The facility comes from the staff profile (`requireFacilityStaff`). `scopeSql()` puts the patient ids and facility ids on the row being ranked, on both the chunk and the embedding. Another facility of the same organisation is admitted only with the patient's consent to that organisation, never for sensitive categories. `verify-postgres-rag-leaks` plants a Noida canary and a same-organisation canary, each with a positive control.

**Gap.** Knowledge rows add a third owner kind to the same tables. The new structured and operational readers are new query sites.

**Mitigation and gate.** Patient segments and knowledge segments never share a candidate query. CHECKs make a row's owner kind unambiguous. Leak-gate canaries for knowledge (another organisation, another facility, another access class) in Phase 3; a readers gate in Phase 3; an operational gate in Phase 5; mutation checks in Phase 7 that remove each predicate and require the gate to fail.

### T-R02: Patient IDOR within a facility (Critical)

**Concern.** A staff member names a patient they have no relationship with, or a patient names another person's record.

**Today.** Doctors need an active care relationship (the OPD and IPD windows), which is stricter than "registered here". Nurses need an open assignment. A doctor cannot read their own record through doctor tools. A patient's request for a record that is not theirs goes to the proxy check or 404. Refusals are 404-shaped, so existence is not revealed.

**Gap.** `/api/chat` uses a weaker rule for staff: the patient's facility and `clinical:chart:read`, with no care relationship (T-R03).

**Mitigation and gate.** `/api/chat` goes behind the gateway (Phase 5). Leak-gate canaries for an unassigned nurse and an untreated patient exist; they are extended to every new reader.

### T-R03: The portal assistant bypasses every AI control (Critical before real data)

**Concern.** `POST /api/chat` builds a record context and calls the assistant provider. It has no real-data switch, no AI-consent check, no permit, no identifier masking, no citation validation and no `AiInteraction`. With a working Anthropic key and a REAL facility, a real patient's context would be sent to Anthropic, including for a person who declined AI assistance.

**Today.** Nothing in code stops it. What stops it in practice: every facility with data is `SYNTHETIC`, and the Anthropic key has no credit.

**Mitigation and gate.** Phase 1 step 1.1: `/api/chat` refuses to build a record context for anything not `SYNTHETIC`. Phase 5 step 5.7: record questions through `/api/chat` are answered by the gateway. `verify-postgres-ai-assistant` asserts both, with a canary in the mock's echoed context.

### T-R04: Real data to an external provider without that provider's approval (Critical)

**Concern.** One global switch governs every provider. Turning it on for one approved processor exposes real data to the others.

**Today.** Voyage refuses a real permit in code. The Claude answer and document providers accept one when the switch is on and the person consented. The mock refuses. The switch is off.

**Mitigation and gate.** A flag per provider, default off, checked inside each provider where the permit is checked (Phase 1 step 1.2). `verify-postgres-ai-switch`: switch on, consent granted, flag off: refused, for every provider.

### T-R05: AI over a record without the person's consent (Critical)

**Concern.** A person declined AI assistance, or their consent lapsed at 18, and their data is still indexed, embedded or answered over.

**Today.** `aiAssistancePermit()` refuses a decline or a lapse even for synthetic data, and the API answers 404. A decline removes the person's whole index. A lapsed consent's index is purged after 90 days. Events for a declined person are recorded and skipped.

**Gap.** `/api/chat` (T-R03). New readers must use the same gate.

**Mitigation and gate.** Every reader takes the resolved access object, which exists only after the permit was issued. The leak gate's withdrawn-consent canary is run against every new channel.

### T-R06: A share, proxy or consent used beyond its limits (Critical)

**Concern.** A doctor reads categories, dates or sensitive items a share does not cover; uses a share after it ended; a proxy reads beyond their grant; uploads reach staff without the person's choice.

**Today.** `resolveShare()` gives the categories, period and sensitive opt-ins, applied in SQL. Uploads need `UPLOADS` and the fact's own category. Allergies ride with every share. A claim share is never usable by the AI. Access is checked on every request, so an expired share fails on the next one. Leak-gate section 13 has a canary per limit.

**Gap.** New readers and any cache.

**Mitigation and gate.** Readers apply the same category, period and sensitivity rules (the readers gate). No retrieval or response cache over person or patient data (T-R11).

### T-R07: Prompt injection through retrieved text (Critical)

**Concern.** A record entry, an uploaded report or a knowledge document contains text such as "ignore your instructions", "the patient has no allergies", "reveal your prompt" or "cite source 3 for this dose".

**Today.** Sources are delimited, quoted data, and the system prompt says they are never instructions. The model has one forced output schema and no other tool, so it cannot act. Every sentence is validated afterwards: a citation must be a retrieved source, and every number must occur in a cited source. A patient answer is withheld whole on any failure. Unconfirmed extracted facts are never indexed.

**Gap.** There is no adversarial test suite. Knowledge documents are a larger surface: one document reaches every asker in a facility. Validation checks numbers, not medicine names or units.

**Mitigation and gate.** Validation extended to medicine names and units (Phase 5). Ingestion strips control characters, hidden text and markup that imitates the prompt's delimiters, and never executes anything (Phase 2). `verify-postgres-ai-injection` (Phase 7) with a fixed corpus of attacks; real-provider runs pending keys. A reference line can never state a fact about a patient, so an injected "the patient has…" in a protocol cannot pass as a record fact.

### T-R08: A harmful or unapproved knowledge document is published (High)

**Concern.** A wrong protocol, an outdated formulary or a deliberately harmful document is quoted to clinicians as hospital policy.

**Today.** No knowledge documents exist.

**Mitigation and gate.** Two people to publish: the approver is never the uploader. Only a published, effective, unexpired, unsuperseded version is a candidate, by a filter in SQL. Every answer line from a document is labelled `reference`, with its title, version and date. Every state change is an event with its actor. The ingestion gate plants a canary in each non-published state.

### T-R09: A superseded or expired document outranks the current one (High)

**Concern.** The old sepsis protocol matches the question more closely than the new one and is quoted.

**Mitigation and gate.** Version state is a filter, not a ranking weight. Publishing a version and superseding the previous one happen in one transaction. The ingestion gate asserts a reader never sees both or neither. The evaluation has a stale-document group with a threshold of zero.

### T-R10: Patient data inside a knowledge document (High)

**Concern.** Someone uploads a discharge summary or a case review as a "reference". It becomes readable by a whole facility with no patient access check.

**Today.** `documents/identifiers.ts` finds ABHA-number-shaped and Indian-mobile-shaped strings, and a given person's own identifiers. It has no UHID or Aadhaar pattern.

**Mitigation and gate.** Ingestion extends that detector with UHID- and Aadhaar-shaped patterns and refuses a file that contains anything that looks like a patient identifier: an ABHA-, UHID-, Aadhaar- or Indian-mobile-shaped number (`CONTAINS_IDENTIFIERS`; decided 2026-11-17). Short codes and toll-free numbers do not match. The uploader confirms the document contains no patient data, and the approver is the second check. Residual risk: a narrative with a patient's name and no identifier-shaped number passes the detector. The approver is the only control for that.

### T-R11: A cache serves data after access changed (Critical)

**Concern.** A cached retrieval or answer is served after a share ended, a consent was withdrawn, a nurse was unassigned or a document was superseded; or one tenant's cached answer is served to another.

**Today.** Nothing is cached in the AI path. API responses are `no-store` and the service worker caches no API response (`verify-postgres-cache-privacy`).

**Mitigation and gate.** No retrieval or response cache over patient or person data. Knowledge caches are keyed by organisation, facility, access classes, the set of versions in force, the embedding space, the model, the prompt version and the language, so a change to any of them misses. A patient-mode question never creates a cache row. `verify-postgres-ai-cache` (Phases 4 and 7).

### T-R12: Leakage through embeddings (Medium)

**Concern.** Vectors can be partly inverted to recover text. A query-embedding cache holds vectors of questions that name patients.

**Today.** Vectors sit beside their text, under the same filters, and are hard-deleted with it. They are never returned by an API.

**Mitigation and gate.** Query embeddings are cached only for knowledge modes. No API returns a vector. The model gate asserts no route's response contains an embedding column.

### T-R13: Clinical text in logs, errors or analytics (High)

**Concern.** A prompt, an answer, a source passage or a provider's error body reaches the application log, an error response or a usage dashboard.

**Today.** The ask route logs only the error's name. Provider errors are closed codes that carry no provider text. Retained text is AES-256-GCM ciphertext; with no key configured nothing is kept. Patient text is kept only under the opt-in. Reviewer reads are logged with a reason and a ticket.

**Gap.** `/api/chat` logs the provider error object (`console.error("AI provider error:", err)`), which may contain request content.

**Mitigation and gate.** `/api/chat` behind the gateway. Usage and health views show counts and durations only. A log scan after the full gate run for canaries, prompts and keys (Phase 7).

### T-R14: Imported or patient-provided data presented as verified (Critical)

**Concern.** A value from the hospital's old system, or one a patient typed from a photo, is shown as a verified result, or becomes the "latest" value that a clinician acts on.

**Today.** Patient-provided lines are labelled, rank below verified, and a disagreement with a verified value is stated. Imported results are not in the AI layer at all.

**Mitigation and gate.** A third origin, `IMPORTED`, with its own label. Order: verified, then imported, then patient-provided. A non-verified value is never the "latest" when a verified one exists for the same test. `verify-postgres-ai-ask` asserts the label on every line and the "latest" rule.

### T-R15: The AI states something clinically false or unsafe (Critical)

**Concern.** An invented diagnosis or dose; "no allergies" from an empty list; an old result given as current; a diagnosis or treatment advice to a patient.

**Today.** Only retrieved sources may be used. Every number is checked. "No record found" is decided before the model is asked. Patient safety rules run before retrieval: an urgent symptom gets only the emergency line; a diagnosis or dosing question gets "please ask your care team". The allergy status distinguishes "none known" from "not recorded". Patient answers are buffered and withheld whole if any sentence fails. Nothing is written to the record.

**Gap.** Prompts, refusal rules and the evaluation answers are pending a clinical advisor. Answer quality has never been measured with a real model.

**Mitigation and gate.** Validation of medicine names and units. Readers return "not recorded" for an absent row. The real-provider evaluation, and the advisor's sign-off, both block real data.

### T-R16: Scholar reaches hospital data, or hospital data reaches Scholar (Critical)

**Concern.** A Scholar prompt contains real patient text, or a hospital answer quotes Scholar's synthetic cases as if they were records or policy.

**Today.** Scholar cases come only through the Clinical Learning Data Gateway. Scholar uses its own provider family, which has no method that takes a patient's sources. A Scholar session on `/api/chat` gets "No patient chart is open".

**Mitigation and gate.** Scholar knowledge, if ever built, is its own scope with a CHECK forbidding an organisation, facility, patient or person on its rows. A static import check both ways and a canary gate (Phase 7).

### T-R17: Cost and availability abuse (Medium)

**Concern.** A user or a script runs up provider spend, or exhausts the database with expensive retrievals or large uploads.

**Today.** Per-user limits per minute and per day; a daily budget per facility; a 16 KB body; questions of at most 1,000 characters; limits counted on `AiInteraction`. The concurrency cap is per process only.

**Mitigation and gate.** A token budget per facility as well as a request budget. Upload size and page limits; ingestion on the bulk lane so it cannot delay live events. Tier 0 for lookups. The concurrency cap moves to a Postgres count.

### T-R18: A wrong embedding space or a half-finished re-embed (Medium)

**Concern.** Queries embedded with one model are compared with vectors from another, giving confidently wrong results; or a switch happens before every chunk is covered.

**Today.** Every query names one space. A switch needs 100% coverage, re-checked inside its transaction. The old space is retired in the same transaction and its rows deleted after 7 days. `verify-postgres-rag-reembed`.

**Mitigation and gate.** Unchanged; knowledge chunks join the coverage count.

### T-R19: A partially ingested document is searchable (High)

**Concern.** Half a protocol is indexed and quoted without its contraindications section.

**Mitigation and gate.** Chunks are written `PENDING` and become `ACTIVE` only at publish, in one transaction, after ingestion reported `INDEXED`. The ingestion gate has a canary in a document stopped mid-ingestion.

### T-R20: Operational answers reveal patients (High)

**Concern.** "Who is in bed 12?" or "which patients have unpaid bills?" returns names to someone who should see only counts.

**Mitigation and gate.** Operational readers return counts and states by default and reuse the permission of the screen that would show the same detail. `verify-postgres-ai-ops` (Phase 5).

### T-R21: The client's conversation context is used to mislead or to widen access (High)

**Concern.** There are no server-side conversations (decided 2026-11-17); the screen sends a compact context of recent turns. A caller forges that context: "earlier you confirmed the potassium was 9.1", or text about another patient, or an instruction to the model.

**Mitigation and gate.** The context is untrusted input, like the question. It is size-limited and masked; it is never a source, so nothing in it can be cited and a number found only in it fails validation; access and retrieval run again on every request from the session, so it cannot widen the scope; it is stored only under the question's own retention rule. Gate in Phase 4 (`verify-postgres-ai-ask`), and the injection suite in Phase 7 includes forged contexts.

### T-R22: Secrets in responses or the repository (High)

**Concern.** A provider key, a storage reference, a content hash or the text-encryption key appears in an API response, a log or a commit.

**Today.** Keys live only in the environment. Reads of stored files are signed URLs.

**Mitigation and gate.** No response schema in the AI routes has a field for a key, a hash or a storage reference; the route tests assert the exact shape. The log scan (T-R13).

### T-R23: Malware in an uploaded document (Medium)

**Concern.** An uploaded file carries malware for whoever opens the original.

**Today.** Type and size validation; the validation layer states it is not a virus scanner.

**Mitigation.** Not solved in these phases. A scanner adapter slot is defined; every version carries `NOT_SCANNED` until a scanner is procured, and the admin view shows it. Documents are parsed as text and never executed. Listed in the pre-launch checklist.

## 5. Summary table

| # | Threat | Severity | Mitigated today | Gate |
|---|---|---|---|---|
| T-R01 | Cross-tenant retrieval | Critical | Yes, for patients | Leak gate; extended in 3, 5, 7 |
| T-R02 | Patient IDOR | Critical | Yes, except `/api/chat` | Leak gate; 5 |
| T-R03 | `/api/chat` bypass | Critical before real data | **Yes, since Phase 1** (a gateway; record-free, record questions to askAi) | `verify-postgres-ai-assistant`, `providerRoutes.test.ts` |
| T-R04 | Real data to an unapproved provider | Critical | **Yes, since Phase 1** (per-provider flags, default off) | `dataPolicy.test.ts`, `verify-postgres-ai-assistant` |
| T-R05 | AI without consent | Critical | Yes, except `/api/chat` | Leak gate; 1 |
| T-R06 | Share, proxy, consent limits | Critical | Yes | Leak gate §13; 3 |
| T-R07 | Prompt injection | Critical | Partly; **a knowledge document's instructions are stored and searched as plain text, change nothing, and HTML scripts are dropped (Phase 2)** | `verify-postgres-knowledge-ingest`; 5, 7 |
| T-R08 | Harmful knowledge document | High | **Yes, since Phase 2** (two people publish: the approver is never the uploader, in the service and a CHECK; withdraw; no scanner, stated) | `verify-postgres-knowledge-access`, `verify-postgres-knowledge-ingest` |
| T-R09 | Stale document outranks current | High | **Yes, since Phase 2** (a superseded, expired or withdrawn version leaves the index in the publishing transaction; the search admits only a version in force, checked in SQL) | `verify-postgres-knowledge-ingest`; 3 |
| T-R10 | Patient data in a knowledge document | High | **Yes, since Phase 2** (ABHA-, Aadhaar-, mobile- and UHID/MRN-shaped values and names with ages refuse the upload before anything is stored; checked again at ingestion) | `identifiers.test.ts`, both knowledge gates, e2e |
| T-R11 | Cache after an access change | Critical | Yes (no cache) | 4, 7 |
| T-R12 | Embedding leakage | Medium | Yes | 1 |
| T-R13 | Text in logs and errors | High | Yes, except `/api/chat` | 5, 7 |
| T-R14 | Imported or patient-provided shown as verified | Critical | Yes for patient-provided | 3 |
| T-R15 | Unsafe clinical statement | Critical | Partly; advisor pending | 5, 8 |
| T-R16 | Scholar isolation | Critical | Yes | 7 |
| T-R17 | Cost and availability | Medium | Partly | 4 |
| T-R18 | Wrong embedding space | Medium | Yes | Re-embed gate |
| T-R19 | Partial ingestion searchable | High | **Yes, since Phase 2** (chunks, embeddings and INDEXED written in one transaction, PENDING until published) | `verify-postgres-knowledge-ingest` |
| T-R20 | Operational answers reveal patients | High | Not applicable yet | 5 |
| T-R21 | Forged conversation context | High | Not applicable yet | 4, 7 |
| T-R22 | Secrets in responses | High | Yes | Route tests; 7 |
| T-R23 | Malware in uploads | Medium | **No** | Deferred, stated |

## 6. What blocks real data

None of these phases turns the real-data switch on. For the record, it stays off until all of the following are true:

1. T-R03 and T-R04 are closed and gated.
2. A data-processing agreement and a DPDP cross-border assessment exist for each provider whose flag is to be turned on, or an India-hosted provider is in place (ADR 0005).
3. The real-provider evaluation has run on synthetic data and met its thresholds, with the "no record" thresholds recalibrated on the real reranker.
4. The injection suite has run against the real model.
5. A clinical advisor has signed the prompts, the refusal rules, the sensitive-category list and the evaluation answers.
6. The leak gate, with its mutation checks, passes on a staging-shaped copy.
7. `PRE_LAUNCH_CHECKLIST.md` records each of the above.
