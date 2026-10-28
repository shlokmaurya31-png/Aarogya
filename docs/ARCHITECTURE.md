# Aarogya architecture

- **Status:** 2026-10-24, at the end of Week 5 (foundation v1).
- **What this is:** the overview a new engineer reads first. The detail lives in the design docs this page links. The rules here are the ones every module follows; `docs/ADD_A_MODULE.md` turns them into steps.

## Contents

1. The shape of the system
2. People and facilities: two kinds of tenant
3. The access resolver
4. The event spine
5. The background runner and consumers
6. The document pipeline
7. The AI over the record (RAG)
8. Sharing, households, the doctor network, insurance
9. Adapters for everything external
10. How we know it works: tests, gates, journeys
11. Where things live

## 1. The shape of the system

One Next.js application (App Router, server routes under `src/app/api/`) and one Postgres database (ADR 0001), with Prisma as the only database client. There are three surfaces:
- **the Hospital OS**, for staff of a facility;
- **the patient app**, for a person and their household;
- **the doctor network**, for doctors listed in the directory.

A separate background worker (`npm run worker`, `scripts/worker.ts`) runs the same code as the runner (§5).

The rules that never bend:
- **One database, transactions everywhere.** A state change and the event that announces it commit together (ADR 0004).
- **Person-level reads go through one function,** `personAccess` (§3).
- **External services sit behind adapters** with a mock that is the default in development, CI and gates (ADR 0003).
- **Real patient data is refused by default.** Data is SYNTHETIC or REAL, per Person and per facility, and REAL data reaches an AI provider only when the global switch is on and the person consented (`src/lib/ai/realData.ts`).

## 2. People and facilities: two kinds of tenant

The data has two owners. Details: `docs/PERSON_IDENTITY_DESIGN.md`.

| Owner | What | Tenancy |
|---|---|---|
| **A facility** (in an organization) | Its patient records (`Patient`), encounters, orders, results, medications, bills, claims, tasks, queues, beds | Every row carries `facilityId`; routes resolve the facility from the session (`requireFacilityStaff`), and another facility's id is a 404. The tenancy sweep gate (`verify-postgres-tenancy-sweep`) probes every route as every tenant. |
| **A Person** | The human: their own login, contacts, consents, uploads and patient-provided facts, shares, notifications, household memberships, insurance cards | Person-scoped models carry `personId` and no facility (`src/lib/person/tenancy.ts`). They are read only through `personAccess`. |

- **The bridge:** a `PersonPatientLink` ties a facility's `Patient` to a `Person`, through verified linking (`src/lib/person/linking.ts`). A Person may have records at many facilities; each facility sees only its own.
- **Facility records never move between facilities.** What crosses is what the person shares (§8).
- **Merges:** a Person merge re-points every person-scoped row (`src/lib/person/merge.ts`, with a test that lists them). A Patient merge inside a facility is read through `resolvePatientIdsForRead`.

## 3. The access resolver

`personAccess(actor, personId, purpose)` (`src/lib/person/access.ts`) is the single decision for person-level data. It returns a grant or `null`, and callers answer `null` with a 404.

| Way in | Who | What it opens |
|---|---|---|
| `OWNER` | The person's own login | Everything person-level |
| `PROXY` | A household proxy with an ACTIVE grant for the permission asked | What the grant's permissions, categories and sensitive opt-ins allow (`src/lib/household/grants.ts`) |
| `STAFF` (care relationship) | Staff of a facility treating the person, if the person chose "share my uploads with hospitals treating me" | Their uploads only |
| `SHARE` | A doctor or facility holding a live share (a code, an approved request, a booking, a check-in, a claim's documents) | Exactly the share's categories, period and sensitive opt-ins, or its documents (`src/lib/sharing/resolve.ts`) |
| `CARD_SHARE` | Facility staff with a card share from a pre-arrival check-in | That one insurance card |

On top of the table:
- **Never your own record through doctor tools.** A doctor can't open their own record that way: the same-human check (`src/lib/doctors/self.ts`) matches verified emails and phones. Staff reading their own chart at their own facility is allowed but recorded as self-access.
- **Every read is logged:** staff and proxy reads of person-level data go to the person's access log (`PersonAccessLogEntry`), which the person can see.

Facility data has its own engine: `src/lib/auth/authorize/engine.ts` covers RBAC, facility boundary, relationship, break-glass, purpose and consent, with audited decisions.

## 4. The event spine

Every state change emits a domain event in the same transaction. Details: `docs/WORKFLOW_SPINE_DESIGN.md` and `docs/EVENT_CATALOGUE.md`.

- **One emit function,** `emitDomainEvent(tx, …)` (`src/lib/events/emit.ts`), writes one outbox row (`DomainEventOutbox`) inside the caller's transaction. The event exists if and only if the change committed.
- **Contracts:** each event type has versioned zod contracts in `src/lib/events/catalogue.ts`. They are strict (an unknown key is refused), carry ids and closed codes only, never names, values or free text, and pass a sensitive-key guard (`sensitiveGuard.ts`). A shipped contract is never changed: a new version is added, producers emit the current one, and consumers and replay accept the old ones.
- **Scopes:**
  - FACILITY and ORGANIZATION events carry their tenant, from the server.
  - PERSON events carry the person and no tenant.
  - PLATFORM events carry neither.
- **CI enforcement:**
  - `emitCoverage.test.ts` fails on any exported service function that writes without emitting, unless it is a listed, categorized exemption (`emitExemptions.ts`).
  - `catalogueDoc.test.ts` keeps `docs/EVENT_CATALOGUE.md` generated from the code (`npm run docs:events`).

## 5. The background runner and consumers

- **The runner:** `runTick` (`src/lib/runner/tick.ts`) dispatches pending events to consumers, fires workflow timers, and runs the sweeps:
  - medication schedules (missed doses);
  - share and request expiry;
  - consent lapses at 18;
  - the next-slot projection;
  - coming of age;
  - card-share expiry and stale check-ins.
- **Consumers** are registered in one place (`src/lib/runner/consumers.ts`, `CONSUMER_REGISTRY`). Every entry point (the worker, `POST /api/cron/tick`, the platform dispatch route, the gates) registers the whole registry; the dispatcher refuses to run while any of it is missing, and marks an event PROCESSED only when every consumer listed for its type has handled it (Flagship 2b; `verify-postgres-consumer-registry`). Each consumer:
  - has a stable name;
  - handles listed types;
  - is idempotent (delivery is at least once, ledgered per event and consumer in `DomainEventDelivery`);
  - writes its own changes with their own events.
- **Examples:** task generation, the MAR scheduler, charge capture, claim drafting, discharge readiness, the document pipeline steps, the RAG indexer, the person notifier, and the check-in and claim-document lifecycles.
- **The core-journey gate** checks that every registered consumer takes part in the journey.

## 6. The document pipeline

A person's upload becomes reviewed, patient-provided record entries. Details: `docs/DOCUMENT_PIPELINE_DESIGN.md`.

`PersonDocumentUploaded` → page split → OCR → language → translation (the exact-copy check protects values) → extraction → the person reviews each fact → confirmed facts become `PatientProvidedRecord` entries, labelled patient-provided (or "confirmed by proxy") → conflicts with verified records are flagged.

- **Each step is a consumer** with its own event, and it is resumable.
- **The real-data gate runs before any provider sees a page:** SYNTHETIC data, or REAL data with the switch on and `DOCUMENT_PROCESSING` granted by the person (or their guardian, for a child).
- **ID proofs and insurance-card photos** are never processed.

## 7. The AI over the record (RAG)

Details: `docs/RAG_DESIGN.md`.

- **Indexing:** the `rag-indexer` consumer keeps an index of the verified record (facility-owned rows) and the person's patient-provided facts and documents (person-owned rows). Each chunk carries provenance labels, categories and sensitive tags.
- **Asking:** `POST /api/ai/ask` (`src/lib/rag/ask.ts`) resolves access first (`src/lib/rag/access.ts`): a staff mode at the staff member's facility, a share, the person's own, or a proxy with USE_AI. Then it retrieves only within that scope, answers only from cited sources, and labels every sentence. It refuses rather than guesses.
- **Retained text** (questions and answers, with consent) is encrypted, and lapses and purges on schedule.
- **Never through the AI:** sensitive categories without an opt-in, a claim's documents, a doctor's own record.

## 8. Sharing, households, the doctor network, insurance

| Module | What it adds | Design |
|---|---|---|
| Consent sharing (4c) | Shares by category, with a period and sensitive opt-ins: visit codes, access requests the person approves, revoke-all, daily access summaries | `docs/CONSENT_SHARING_DESIGN.md` |
| Doctor network (5a) | Verified doctors in a public directory, booking with a share, visit briefs, the same-human rule | `docs/DOCTOR_NETWORK_DESIGN.md` |
| Households (5b) | Members with their own Persons; proxy grants (permissions, categories, sensitive opt-ins), guardians of children with parental consent, dependent adults, coming of age at 18 | `docs/HOUSEHOLD_DESIGN.md` |
| Patient insurance (5c) | Insurance cards, pre-arrival check-in with a token, eligibility never waited for, plain-language status of pre-auth, cashless, bill, share and claim, paying the share to the hospital's own gateway, claim documents | `docs/PATIENT_INSURANCE_DESIGN.md` |

All four reuse the same pieces: Person ownership, `personAccess`, shares resolved on every read, events in the transaction, and the access log.

## 9. Adapters for everything external

Each external service sits behind an adapter with a deterministic mock (ADR 0003):
- **Messaging:** email and SMS, with outboxes in development.
- **Storage:** local disk or S3.
- **AI:** document providers (OCR, translation, extraction), the answer model and embeddings.
- **Payments:** the SaaS Razorpay adapter, and each facility's own gateway in 5c.
- **Exchanges:** NHCX and ABDM.

The mocks are the default everywhere except where a real provider is configured and its pre-launch item says it may be used (`docs/PRE_LAUNCH_CHECKLIST.md`). Secrets come only from the environment and are never stored, returned or put in an event.

## 10. How we know it works: tests, gates, journeys

| Check | Command | What |
|---|---|---|
| Unit and rule tests | `npm test` | Pure logic, the catalogue, emit coverage, tenancy and merge classification, the guards |
| Lint and types | `npm run lint`, `npm run build` | Blocking in CI |
| Gates | `npm run verify:all` | About 115 scripts against a reset local database (`aarogya_verify`; a shared guard refuses any other). Each proves one area's guarantees with positive controls and zero-tolerance leak checks. The core journey replays a whole hospital stay and the person-side stories |
| Browser journeys | `npm run e2e:smoke` | Playwright (Chromium) through the real app and worker, on synthetic, tagged fixtures |
| Migration drift | CI | The migrations must produce exactly the schema |

## 11. Where things live

| Path | What |
|---|---|
| `prisma/schema.prisma`, `prisma/migrations/` | The one schema; additive migrations that refuse rather than guess |
| `src/lib/<module>/` | Services: the only code that writes. `hospital/` (clinical, ADT, billing), `person/`, `sharing/`, `household/`, `doctors/`, `insurance/`, `documents/`, `rag/`, `events/`, `runner/`, `auth/` |
| `src/app/api/` | Thin routes: authenticate, resolve the tenant or person, call one service, return its result |
| `src/app/hospital-os/`, `src/app/patient/` | Screens |
| `scripts/verify-postgres-*.ts` | Gates (each imports `scripts/lib/gateBootstrap` first) |
| `e2e/` | Browser journeys |
| `docs/` | Designs (each ends with an "as built" section), ADRs, the pre-launch checklist |
