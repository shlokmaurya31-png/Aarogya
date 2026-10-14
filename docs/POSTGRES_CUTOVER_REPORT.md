# Postgres cutover triage report

- **Date:** 2026-10-13
- **Branch:** `foundation/w1-postgres` (draft PR #1)
- **Scope:** every automated check run against local PostgreSQL 16 + pgvector
  after the switch to a single Postgres database
  ([ADR 0001](adr/0001-postgres-single-database.md)), plus a search for
  SQLite-specific code that is still present.
- **Nothing was fixed** while writing sections 1–5. The fixes made on
  2026-10-14, and the final status, are in [section 6](#6-fix-log-and-final-status-2026-10-14).

## How the checks were run

| Check | Command | Database |
|---|---|---|
| Integrity gates | `npm run verify:all -- --fresh-each` | Throwaway `aarogya_verify` database in the local `aarogya-db` container. It was reset, migrated and seeded before each script, then dropped. The seeded dev database was left untouched. |
| Unit tests | `npm test` | `DATABASE_URL` set to the local `aarogya` database |
| Production build | `npm run build` | `DATABASE_URL` set to the local `aarogya` database |
| Migration drift | `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url $SHADOW_DATABASE_URL --exit-code` | Local `aarogya_shadow` |
| CI on PR #1 | GitHub Actions run 38471668138, plus the Vercel preview | GitHub-hosted runners |

`verify-abdm-sandbox.ts` is excluded from `verify:all` because it needs real
ABDM sandbox credentials. Without them it reports BLOCKED and exits 0. See
`scripts/verify-all.ts`.

## 1. Results

Of the checks below, 43 run locally (40 gates, unit tests, build, drift) and all
pass; the 44th is a lint pass. Exactly one check fails: the CI migration-drift
job.

| # | Check | Result | Duration | Failure summary |
|---|---|---|---|---|
| 1 | verify-postgres-diagnostics | PASS | 0.7s | |
| 2 | verify-postgres-scheduling | PASS | 0.6s | |
| 3 | verify-postgres-bed-concurrency | PASS | 0.6s | |
| 4 | verify-postgres-appointment-concurrency | PASS | 0.5s | |
| 5 | verify-postgres-queue-concurrency | PASS | 0.4s | |
| 6 | verify-postgres-empi-adt-concurrency | PASS | 1.5s | |
| 7 | verify-postgres-billing-concurrency | PASS | 0.7s | |
| 8 | verify-postgres-medication-concurrency | PASS | 0.6s | |
| 9 | verify-postgres-nursing-concurrency | PASS | 0.5s | |
| 10 | verify-postgres-inventory-concurrency | PASS | 0.5s | |
| 11 | verify-postgres-pharmacy | PASS | 0.8s | |
| 12 | verify-postgres-procurement-concurrency | PASS | 0.5s | |
| 13 | verify-postgres-inventory-procurement | PASS | 0.7s | |
| 14 | verify-inventory-e2e | PASS | 0.6s | |
| 15 | verify-inventory-security | PASS | 0.5s | |
| 16 | verify-postgres-emergency-department | PASS | 0.6s | |
| 17 | verify-postgres-icu-clinical | PASS | 0.6s | |
| 18 | verify-postgres-icu-concurrency | PASS | 0.6s | |
| 19 | verify-postgres-ot-concurrency | PASS | 0.6s | |
| 20 | verify-postgres-blood-bank | PASS | 0.8s | |
| 21 | verify-postgres-emr-documents | PASS | 0.5s | |
| 22 | verify-postgres-operations | PASS | 0.6s | |
| 23 | verify-postgres-interoperability | PASS | 1.0s | |
| 24 | verify-postgres-abdm-readiness | PASS | 0.6s | |
| 25 | verify-postgres-abdm-integration | PASS | 0.8s | |
| 26 | verify-postgres-trust-layer | PASS | 0.6s | |
| 27 | verify-postgres-nhcx | PASS | 1.1s | |
| 28 | verify-postgres-interoperability-control-plane | PASS | 0.8s | |
| 29 | verify-postgres-enterprise-tenancy | PASS | 0.6s | |
| 30 | verify-postgres-commercial-entitlements | PASS | 1.8s | |
| 31 | verify-postgres-saas-billing | PASS | 1.0s | |
| 32 | verify-postgres-d4-billing | PASS | 0.8s | |
| 33 | verify-postgres-d5-commercial | PASS | 0.8s | |
| 34 | verify-postgres-d6-events | PASS | 0.8s | |
| 35 | verify-postgres-d7-workflows | PASS | 1.1s | |
| 36 | verify-postgres-d8-configuration | PASS | 0.9s | |
| 37 | verify-postgres-d9-builder | PASS | 0.9s | |
| 38 | verify-postgres-d10-command-center | PASS | 0.9s | |
| 39 | verify-postgres-d11-patient-experience | PASS | 0.6s | |
| 40 | verify-postgres-phase-b-final | PASS | 0.6s | |
| 41 | `npm test` (73 files, 981 tests) | PASS | 4s | |
| 42 | `npm run build` (336 static pages) | PASS | 48s | |
| 43 | Migration drift, local | PASS | 3s | |
| 44 | CI: Lint | PASS | 1m17s | |
| 45 | CI: Test & Build | PASS | 2m21s | |
| 46 | **CI: Migration drift** | **FAIL** | 1m7s | `The shadow database you configured appears to be the same as the main database.` |
| 47 | CI: Vercel preview | PASS | n/a | The build succeeded. Runtime was not checked (see F3). |

`verify:all` took 4m53s in total, about 6s of reset, migrate and seed per
script. The gates use under 2s each.

The gates are fast but real: run on its own, `verify-postgres-phase-b-final`
prints `PASS 74 / FAIL 0`. `verify:all` was also shown to catch a failing
script, a timed-out script, and the last 40 lines of output.

## 2. Failures and root causes

Classes: (a) real application bug, (b) script/test bug, (c) seed/data
problem, (d) environment/config.

### F1. CI migration-drift job: `DATABASE_URL` equals `SHADOW_DATABASE_URL` (d)

- **Root cause:** commit `a3239b0` set both variables in the `migration-drift`
  job of `.github/workflows/ci.yml` to
  `postgresql://postgres:postgres@localhost:5432/shadow`. Prisma refuses to use
  the main database as the shadow database, because it wipes the shadow.
- **Class:** (d) environment/config. The migrations and the schema are
  consistent: the same check passes locally (#43).
- **Fix:** point `SHADOW_DATABASE_URL` at a second database in the service
  container, for example by creating `shadow` and `main` with a
  `psql -c "CREATE DATABASE ..."` step, or by using the service's default
  database for `DATABASE_URL`. Scheduled for prompt 8.

### F2. Text search became case-sensitive (a), found by code search, not by a check

No check failed for this, which is the problem: no test or gate covers
case-insensitive search. On SQLite, Prisma's `contains` compiles to `LIKE`,
which ignores case for ASCII. On PostgreSQL, `contains` is case-sensitive
unless `mode: "insensitive"` is set, and no query in `src/` sets it.

Shown on the seeded dev database:

| Query | Matching rows |
|---|---|
| `patient.fullName contains "Rohit"` | 2 |
| `patient.fullName contains "rohit"` / `"ROHIT"` | 0 / 0 |
| `clinicalCase.title contains "Chest"` / `"chest"` | 4 / 0 |
| `item.name contains "Paracetamol"` / `"paracetamol"` | 2 / 0 |

Affected call sites (9 filters in 4 places):

- `src/app/api/hospital/patients/route.ts:23-27`: Hospital OS patient search
  on name, UHID, phone and identifiers. Typing a patient's name in lower case
  now returns nothing. This is the highest-traffic search in Hospital OS.
- `src/lib/hospital/inventory/items.ts:66`: inventory item search, on name and
  SKU.
- `src/lib/clinical/providers/syntheticCaseProvider.ts:67-69`: Scholar case
  library search, on title, chief complaint and specialty.
- `src/app/api/hospital/invoices/route.ts:24`: invoice-number search. Invoice
  numbers are generated in upper case, so lower-case input misses.

Emails are not affected: login and registration lower-case them before
lookup.

### F3. Vercel runtime database is unverified (d), a risk rather than an observed failure

The Vercel preview build passes because `next build` does not connect to the
database. The preview's runtime `DATABASE_URL` was not checked. If it is still
a `file:` URL, or unset, every database-backed page fails at runtime now that
the Prisma client is generated for `postgresql`. This needs a staging Postgres
(Supabase) and its URL set in Vercel; it belongs to prompt 9.

## 3. Shared root causes

- **F2's four call sites share one root cause:** Prisma's case behaviour
  differs between dialects, and nothing passes `mode: "insensitive"`. One fix
  pattern covers all nine filters.
- **F1 and F3 are separate configuration gaps** with the same theme:
  environment URLs were not updated alongside the code. F1 is in CI; F3 is in
  Vercel.
- **No gate, test or seed failure shares a cause with anything,** because none
  failed.

## 4. Fix order (highest impact first)

1. **F2, case-sensitive search (a).** It is user-visible in Hospital OS patient
   search, and it would ship silently, because CI cannot catch it. Fix: add
   `mode: "insensitive"` to the nine filters. Add a unit or gate test that
   searches in lower case, so the gap stays closed. For patient name search at
   scale, consider a `pg_trgm` GIN index later.
2. **F1, CI drift job (d).** It blocks a green PR, and it is a one-line fix.
   Prompt 8.
3. **F3, Vercel/staging `DATABASE_URL` (d).** Required before anyone uses a
   preview or staging deploy. Prompt 9.
4. **Clean-up from section 5,** in the order listed there. None of it is a
   correctness problem today.

## 5. SQLite-specific code still present

Search terms used: `sqlite`, `file:`, `dev.db`, provider `sed` swaps,
`$queryRaw`/`$executeRaw`, `IS_PG`/`isPostgres`, `SQLITE_BUSY`.

**No problems found:**

- **No `file:` database URLs remain** in code, CI, `package.json`,
  `.env.example` or `docker-compose.yml`.
- **No provider `sed` swaps remain.** The two that existed in docs were
  replaced in `a3239b0`. The only `provider = "sqlite"` left is the frozen
  `prisma/archive/migrations-sqlite/migration_lock.toml`, as intended.
- **Raw SQL is portable.** There are 37 `$executeRaw` call sites in `src/`.
  All use standard SQL (`INSERT ... ON CONFLICT DO NOTHING`,
  `CURRENT_TIMESTAMP`, guarded `UPDATE ... WHERE`) with tagged-template
  placeholders, so Prisma generates `$1` for Postgres. None uses SQLite-only
  syntax (`INSERT OR`, `randomblob`, `datetime('now')`, `strftime`,
  `julianday`). The gates exercise all of them on Postgres.
  `src/lib/hospital/procurement/sequence.ts` and `controlPlane/operations.ts`
  deliberately avoid dialect-specific raw SQL, and their comments say so.

**Still to clean up:**

| Item | Where | Impact | Suggested action |
|---|---|---|---|
| Dialect check by URL prefix | `src/lib/hospital/appointment.ts:31`: `isPostgres = () => DATABASE_URL?.startsWith("postgres")` gates the `pg_advisory_xact_lock` that stops double-booking a doctor. | Medium. A non-`postgres*` URL, such as `prisma://` from Prisma Accelerate or a misconfigured env, would silently skip the lock and reopen the double-booking race. | Always take the lock, and delete `isPostgres`. |
| Dead SQLite branches in gates | 9 `verify-postgres-*` scripts (d4, d5, d6, d7, d8, d9, enterprise-tenancy, commercial-entitlements, saas-billing) **skip their concurrency races** when `IS_PG` is false; d10 and d11 use `IS_PG` only for a label. | Low today, since `verify:all` always uses Postgres. But a gate can pass with its races skipped. | Remove the `IS_PG` branches, so races always run and a non-Postgres URL fails loudly. |
| JSON arrays stored as `String` | `schema.prisma` lines 220, 288, 297, 433, 442: `clinicalInterests`, `learnerTracks`, `learningObjectives`, `tags`, `caseIds` | Low. Correct, but they can't be queried or indexed and need `JSON.parse`/`JSON.stringify` at every use. | Migrate to `String[]` or `Json` in a dedicated, additive migration. |
| Enums kept as text "enforced in code" | 8 schema comments describe text columns kept as strings for SQLite portability. | Low. The database doesn't validate the values. | Review case by case; convert to Postgres enums where the value set is closed. |
| `SQLITE_BUSY` / `database is locked` in retry detection | `src/lib/auth/rbac.ts:61`, test `src/lib/auth/apiErrors.test.ts:47` | None. Harmless dead pattern. | Remove with its test. |
| SQLite rationale in comments | ~20 comments in `src/lib/**`, ~8 in `schema.prisma` | None. Misleading to new readers. | Reword when those files are next touched. |
| Public marketing copy | `src/app/(site)/company/about/page.tsx:77`: "gates on both SQLite and PostgreSQL" | Low, but public. No longer true. | Update the copy. |
| Leftover local file | `prisma/dev.db` (5.7 MB, untracked, gitignored) | None. | Delete locally once nothing from it is needed. |
| Stale ignore entries | `.gitignore:59,66`: `/.pgreplay/`, `/.pgreplay-dev.log` | None. | Remove. |
| Historical docs | 41 files in `docs/` mention SQLite or `dev.db` | None. Phase records. | Leave as history, per ADR 0001. |

**Postgres behaviour to audit (not SQLite code, but SQLite masked it).** There
are 59 of 91 `findFirst` calls in `src/` with no `orderBy` on the same line;
this is a line-based count, so some have `orderBy` on a later line. Where
`where` can match several rows, Postgres guarantees no order, so the row
returned can vary. The seed had this problem in phases 5 and 6A; it was fixed
in `6c3f0de`. These calls are worth a pass, starting with ones whose result
picks an actor or a "current" record.

## 6. Fix log and final status (2026-10-14)

Fixed in the section 4 order, with one commit per root cause. After each
fix, the affected checks were re-run with
`npm run verify:all -- --only <pattern> --fresh-each` on a throwaway local
database. No assertion was weakened, no test was skipped and no invariant
was loosened. The two test changes **strengthen** gates; reasons are below.
There were no schema changes, so no new migration was needed, and drift
stays at exit 0.

### Fixes

| Commit | Root cause | Class | Change | Re-check |
|---|---|---|---|---|
| `9f6bc44` | **F2:** `contains` is case-sensitive on Postgres | (a) | Added `textContains()` in `src/lib/search.ts`, setting `mode: "insensitive"`. All nine search filters use it. Patient search moved to `src/lib/hospital/patientSearch.ts`, so the route and the gate run one query. New gate `verify-postgres-search`. | Gate fails 5/5 on the old filters and passes 5/5 now. `--only search --fresh-each`: 1/1. |
| `da29059` | **New, found while fixing F2:** `listItems` had two `OR` keys, so the search replaced the facility scope. Inventory search returned other facilities' items: Pune saw Noida's "Amoxicillin". Pre-existing, not caused by the cutover. | (a), tenant isolation | The two OR-groups are now combined with `AND`. The search gate asserts no foreign items. A scan of every `where: {}` in `src/` found no other duplicate-`OR` object; the scanner was confirmed to catch the original bug. | Fails on the old code (`foreign=1`). `--only search,inventory --fresh-each`: 5/5. |
| `ac22c9b` | **F1:** the CI drift job had `DATABASE_URL` equal to `SHADOW_DATABASE_URL` | (d) | `DATABASE_URL` now points at the service's built-in `postgres` database. This is the minimal fix; the CI rework is still planned for prompt 8. | Reproduced locally: the same URLs exit 1 with the CI error, and distinct URLs exit 0. Not yet seen on GitHub, because the branch isn't pushed. |
| `bcf21b5` | **§5:** the double-booking advisory lock depended on `DATABASE_URL.startsWith("postgres")` | (a) | The lock is now unconditional and `isPostgres()` is removed. | 30 trials of 5 concurrent bookings: 30/30 double-booked without the lock, 0/30 with it. |
| `b8425ba` | **Gate weakness:** the appointment race was a single two-way race that **passed with the lock removed** | (b) | Step 6 is now 10 rounds of 5 concurrent bookings, each needing exactly 1 winner and 4 `SlotConflictError`s. The test was wrong because it could not detect the failure it documents; the assertion is now stronger. | Without the lock: FAIL (`cleanRounds=1/10, maxWinners=5`). With it: PASS on 3/3 fresh runs. |
| `fc725ea` | **§5:** 9 gates skipped their races when `IS_PG` was false | (b) | Removed `IS_PG`, the skip branches and the dialect labels from 11 scripts. Races always run. | `--only <those 11> --fresh-each`: 11/11. |
| `c374b4c` | **§5:** stale SQLite claims | n/a | The About page no longer claims SQLite gates. Dropped the `.pgreplay` ignore entries. | Lint and build pass. |

### Final status

| Check | Result | Duration |
|---|---|---|
| `npm run verify:all` (41 gates, including the new `verify-postgres-search`) | **41/41 PASS** | 49.8s |
| `npm test` (73 files) | **981/981 PASS** | 4s |
| `npm run lint -- --max-warnings=0` | **PASS** | 16s |
| `npm run build` | **PASS** | 47s |
| Migration drift (local) | **PASS**, exit 0 | 2s |
| CI drift job | Fixed and verified locally; confirm on the next push | n/a |

### Not fixed, with reasons

| Item | Reason |
|---|---|
| **F3:** Vercel's runtime `DATABASE_URL` | It needs a staging Postgres (Supabase), and its URL set in Vercel. Neither exists yet. Planned for prompt 9. |
| CI drift fix confirmed on GitHub | The branch isn't pushed. The fix was reproduced and verified locally with the same command. |
| JSON arrays stored as `String` (5 columns) and text "enums" (8) | These aren't failures. Each is a schema and data-shape change that needs a migration that converts existing rows, plus updates to every reader. It also needs a product decision on the API shape. Better as its own reviewed change. |
| `SQLITE_BUSY` / `database is locked` in `rbac.ts`, and its unit test | Harmless dead pattern. Removing it means deleting a test, which these rules say not to do without a reason that goes beyond tidiness. Left for an explicit decision. |
| SQLite rationale in ~28 code comments | No behaviour impact. To be reworded when those files are next touched. |
| `prisma/dev.db` | A local, untracked file that the owner should delete. |
| `findFirst` calls without `orderBy` (59 of 91, rough count) | Needs a case-by-case review; nothing is failing. It's still on the follow-up list. |
| New, out of scope: `GET /api/hospital/invoices` | The `total` count ignores the `invoiceNumber` filter, so `total` can exceed the filtered rows. It was found while fixing F2. It is pre-existing and unrelated to Postgres, and should be fixed separately. |
| `verify-abdm-sandbox` | Still excluded from `verify:all`. It needs real ABDM sandbox credentials. |

**Status update (2026-10-14, later):**
- **Fixed:**
  - The F3 runtime URL setup (`d0306b2`).
  - The CI drift fix, now confirmed on GitHub.
  - The invoice `total` (`ebe87a4`).
  - Every row-order-dependent `findFirst`/`findMany` (`50c00ab`).
- **The JSON and text-enum columns are now inventoried column by column** in
  §8 (Week 2 schema audit). The earlier "8 text enums" counted only obvious
  status columns; the systematic scan finds 156, including every status,
  priority and type column. They are still unchanged by design.

## 7. CI on Postgres (prompt 8)

CI now runs every job against a `pgvector/pgvector:pg16` service:

- **Test & Build:** runs `prisma migrate deploy` before the tests and the
  build.
- **Integrity gates:** a new job that runs `npm run verify:all` and uploads
  `.verify-report/latest.md` as the `verify-report` artifact.
- **Migration drift:** runs as before.
- **Lint:** already blocking, with `--max-warnings=0`.

No `file:` URL remains in CI.

The first CI run of the gates job found one more real bug:

| Commit | Root cause | Class | Evidence |
|---|---|---|---|
| `2bc1d9b` | `enforceLimit` held a SERIALIZABLE transaction, while `resolveLimit` queried the **global** client and so needed a second pooled connection. Prisma's default pool is `2 × CPUs + 1`, which is 5 on the 2-core runner. Six concurrent creates exhausted the pool and every transaction timed out at 5s. Developer machines have bigger pools, which hid it. | (a) | CI: `commercial-entitlements` 24 passed / 2 failed (`facility limit race`, `user limit race`, `succeeded=0`). Reproduced locally with `?connection_limit=5`. After the fix it passes at pool 5 (3/3 fresh) and at pool 2, and the full `verify:all` passes 41/41 at pool 5. |

**Lesson:** CI's small connection pool is a useful stress setting. A local run
with `?connection_limit=5` on `DATABASE_URL` reproduces it.


## 8. Week 2 schema audit (recorded 2026-10-14; nothing changed yet)

This is an inventory for Week 2. **No column has been changed.** Each entry
says whether today's representation is deliberate, or should become `jsonb`,
a Postgres array or a native enum.

**How the columns were found.**
- **JSON stored as text:** `String` columns documented as JSON, defaulting
  to `"[]"`/`"{}"`, or read with `JSON.parse`/written with `JSON.stringify`
  in code.
- **Enums stored as text:** `String` columns with an upper-case constant
  default or a comment listing `A | B | C` values.

There are already 29 real `Json` columns and many native enums (for example
`EncounterStatus`, `PaymentMethod`), so the mix is a leftover, not a policy.
The heuristic can miss a status column that has neither a default nor a
value comment; Week 2 should grep `status String` once more before
migrating.

### 8.1 JSON stored as text

| Column | Holds | Verdict |
|---|---|---|
| `StudentProfile.clinicalInterests` | JSON-encoded `string[]` | **Should become `String[]`** (Postgres `text[]`). A flat list of strings needs no `jsonb`. |
| `ClinicalCase.learningObjectives` | JSON `string[]` | **Should become `String[]`.** |
| `NotebookEntry.tags` | JSON `string[]` | **Should become `String[]`.** This also enables `has`/`hasSome` tag filters in Postgres instead of parsing in memory. |
| `LearningRecommendation.caseIds` | JSON `string[]` of `ClinicalCase` ids | **Should become `String[]`**, or a join table if referential integrity to `ClinicalCase` matters. |
| `ClinicalCase.learnerTracks` | JSON-encoded `LearningTrack[]` | **Should become a native enum array** (`LearningTrack[]`) if the track set is closed in code; otherwise `String[]`. |
| `ConfigurationOverride.value`, `OrgConfigValue.value`, `FacilityConfigValue.value`, `DepartmentConfigValue.value` | A serialized value whose type is set by `valueType` (BOOLEAN / NUMBER / STRING / ENUM / DURATION / JSON) | **Deliberate text.** The value is polymorphic, `src/lib/config/registry.ts` validates and parses it per type, and text is its canonical, auditable form. `jsonb` would add nothing for the 5 scalar types. |

Each change is a migration with
`USING (SELECT array_agg(x) FROM json_array_elements_text(col::json) x)`
plus code changes at every `JSON.parse`/`JSON.stringify` site. Those sites
are all in the Scholar (student) module.

### 8.2 Enums stored as text

156 columns: **136 should become native enums, and 20 are deliberately
text.**

**Deliberately text:**
- **ISO 4217 currency codes** (13 columns): an external, open code set.
  Keep text and add a 3-letter `CHECK`.
- **Open, organization-extensible taxonomies:**
  - `StaffPrivilege.privilegeType`;
  - `QualityIncident.category`;
  - `BillingInvoiceSequence.scope`.
- **Vocabularies owned by an external spec:**
  - ABDM consent purpose and HI-type scope;
  - ABDM and NHCX protocol states (the NHCX contract isn't verified yet).

**Things to plan for when migrating:**

- **Shared value sets.** `ROUTINE | URGENT | STAT` repeats across 9 tables:
  `LabOrder`, `ImagingOrder`, `Referral`, `Task`, `WorkflowTask`,
  `HousekeepingRequest`, `MaintenanceRequest`, `PatientTransportRequest` and
  `DepartmentSupplyRequest`. It should be one `Priority` enum.
  `Notification.priority` differs (`CRITICAL`, not `STAT`) and stays
  separate. Severity sets (`LOW | MODERATE | HIGH | CRITICAL` and
  `INFO | WARNING | CRITICAL`) should likewise each be one enum.
- **Raw SQL.** Postgres won't implicitly cast a bound text parameter to an
  enum in an `INSERT` (error 42804; see `src/lib/hospital/billing/
  payments.ts`). Every `$executeRaw` that writes a converted column needs a
  `Prisma.raw` literal or an explicit `::"EnumName"` cast. The idempotent
  billing, inventory and procurement inserts are the ones to check.
- **Data check first.** Before each `ALTER COLUMN … TYPE … USING col::"Enum"`,
  run `SELECT DISTINCT col` on staging to prove no stray values exist; the
  migration fails on the first one.
- **"Defined in code" rows** have no value comment in the schema. Their
  value set must be taken from the module's TypeScript union or state
  machine, which is the source of truth.
- **Order of work.** Go module by module, one migration each, and keep that
  module's integrity gate green. Start with the platform tables (events,
  workflows), whose state machines are fully closed.

**Platform: events, workflows, configuration**

| Column | Default | Values | Verdict |
|---|---|---|---|
| `DomainEventOutbox.status` | `PENDING` | PENDING \| PROCESSING \| PROCESSED \| RETRY \| DEAD_LETTER | Native enum |
| `DomainEventDelivery.status` | `PENDING` | PENDING \| PROCESSED \| FAILED \| DEAD_LETTER | Native enum |
| `WorkflowDefinition.status` | `ACTIVE` | ACTIVE \| INACTIVE | Native enum |
| `WorkflowVersion.status` | `DRAFT` | DRAFT \| PUBLISHED \| RETIRED | Native enum |
| `WorkflowInstance.status` | `RUNNABLE` | RUNNABLE \| RUNNING \| WAITING \| COMPLETED \| FAILED \| CANCELLED | Native enum |
| `WorkflowStep.stepType` | — | CONDITION \| ACTION \| TASK \| TIMER | Native enum |
| `WorkflowStep.status` | `PENDING` | PENDING \| RUNNING \| WAITING \| COMPLETED \| SKIPPED \| FAILED | Native enum |
| `WorkflowTask.priority` | `ROUTINE` | ROUTINE \| URGENT \| STAT | Native enum |
| `WorkflowTask.status` | `OPEN` | OPEN \| IN_PROGRESS \| COMPLETED \| CANCELLED \| EXPIRED | Native enum |
| `WorkflowTimer.kind` | — | DELAY \| SLA | Native enum |
| `WorkflowTimer.status` | `PENDING` | PENDING \| CLAIMED \| COMPLETED \| CANCELLED | Native enum |
| `ConfigurationOverride.scope` | — | ORGANIZATION \| FACILITY \| DEPARTMENT | Native enum |
| `ConfigurationOverride.status` | `DRAFT` | DRAFT \| PUBLISHED \| RETIRED | Native enum |
| `ConfigurationChange.action` | — | SET \| PUBLISH \| RESET \| RETIRE | Native enum |
| `WorkflowBuilderDraft.status` | `DRAFT` | DRAFT (builder-only lifecycle) | Native enum |

**SaaS billing and commercial**

| Column | Default | Values | Verdict |
|---|---|---|---|
| `OrganizationBillingAccount.currency` | `INR` | _defined in code_ | ISO 4217 currency code — an external, open code set. Keep text; add a 3-letter CHECK. |
| `PlanPrice.currency` | `INR` | _defined in code_ | ISO 4217 currency code — an external, open code set. Keep text; add a 3-letter CHECK. |
| `BillingInvoice.currency` | `INR` | _defined in code_ | ISO 4217 currency code — an external, open code set. Keep text; add a 3-letter CHECK. |
| `BillingInvoiceSequence.scope` | `SAAS` | _defined in code_ | Sequence namespace key (`SAAS`, …), not a closed set. Keep text. |
| `BillingPaymentAttempt.currency` | `INR` | _defined in code_ | ISO 4217 currency code — an external, open code set. Keep text; add a 3-letter CHECK. |
| `BillingPayment.currency` | `INR` | _defined in code_ | ISO 4217 currency code — an external, open code set. Keep text; add a 3-letter CHECK. |
| `BillingCredit.currency` | `INR` | _defined in code_ | ISO 4217 currency code — an external, open code set. Keep text; add a 3-letter CHECK. |
| `BillingReconciliationException.severity` | `MEDIUM` | _defined in code_ | Native enum |
| `BillingReconciliationException.status` | `OPEN` | _defined in code_ | Native enum |
| `BillingReconciliationException.source` | `RECONCILIATION` | _defined in code_ | Native enum |
| `CollectionActivity.type` | — | NOTE \| CONTACT \| PROMISE_TO_PAY \| ESCALATION | Native enum |

**Clinical core**

| Column | Default | Values | Verdict |
|---|---|---|---|
| `Patient.registrationStatus` | `ACTIVE` | "ACTIVE" \| "INACTIVE" | Native enum |
| `PatientIdentifier.status` | `ACTIVE` | "ACTIVE" \| "INVALID" \| "SUPERSEDED" | Native enum |
| `Allergy.status` | `ACTIVE` | "ACTIVE" \| "INACTIVE" \| "ENTERED_IN_ERROR" | Native enum |
| `Allergy.verification` | `UNCONFIRMED` | "UNCONFIRMED" \| "CONFIRMED" | Native enum |
| `EpisodeOfCare.status` | `ACTIVE` | "ACTIVE" \| "CLOSED" | Native enum |
| `Diagnosis.status` | `ACTIVE` | "ACTIVE" \| "RESOLVED" \| "ENTERED_IN_ERROR" | Native enum |
| `ClinicalNote.status` | `SIGNED` | "DRAFT" \| "SIGNED" \| "AMENDED" \| "SUPERSEDED" | Native enum |
| `LabOrder.priority` | `ROUTINE` | ROUTINE \| URGENT \| STAT | Native enum |
| `ImagingOrder.modality` | — | XRAY \| CT \| MRI \| USG \| MAMMOGRAPHY \| INTERVENTIONAL | Native enum |
| `ImagingOrder.priority` | `ROUTINE` | _defined in code_ | Native enum |
| `ImagingStudy.imageAvailability` | `NONE` | _defined in code_ | Native enum |
| `Task.priority` | `ROUTINE` | "ROUTINE" \| "URGENT" \| "STAT" | Native enum |
| `Task.status` | `OPEN` | OPEN \| ASSIGNED \| IN_PROGRESS \| COMPLETED \| CANCELLED \| OVERDUE | Native enum |
| `ClinicalDocument.status` | `CURRENT` | "CURRENT" \| "SUPERSEDED" | Native enum |
| `ClinicalDocument.accessPolicy` | `CLINICAL_STAFF` | "CLINICAL_STAFF" \| "PATIENT_VISIBLE" \| "RESTRICTED" | Native enum |
| `Consent.status` | `REQUESTED` | REQUESTED \| GRANTED \| DENIED \| REVOKED \| EXPIRED | Native enum |
| `Referral.priority` | `ROUTINE` | ROUTINE \| URGENT \| STAT | Native enum |
| `Referral.status` | `PLACED` | DRAFT \| PLACED \| ACKNOWLEDGED \| IN_PROGRESS \| COMPLETED \| CANCELLED \| REJECTED | Native enum |
| `Appointment.status` | `REQUESTED` | REQUESTED\|CONFIRMED\|RESCHEDULED\|ARRIVED\|CHECKED_IN\|WAITING\|IN_CONSULTATION\|COMPLETED\|CANCELLED\|NO_SHOW | Native enum |
| `QueueEntry.status` | `WAITING` | WAITING \| CALLED \| IN_SERVICE \| COMPLETED \| SKIPPED \| CANCELLED | Native enum |
| `TriageAssessment.status` | `COMPLETED` | "DRAFT" \| "COMPLETED" \| "AMENDED" | Native enum |
| `AdmissionRequest.status` | `PENDING` | PENDING \| DEFERRED \| BED_RESERVED \| ADMITTED \| REJECTED \| CANCELLED | Native enum |
| `TransferRequest.status` | `REQUESTED` | REQUESTED \| ACCEPTED \| BED_RESERVED \| PATIENT_IN_TRANSIT \| COMPLETED \| CANCELLED \| REJECTED | Native enum |
| `IcuDevice.status` | `PLANNED` | "PLANNED" \| "ACTIVE" \| "REMOVED" \| "DISCONTINUED" | Native enum |
| `IcuInfusion.status` | `RUNNING` | "RUNNING" \| "PAUSED" \| "STOPPED" | Native enum |
| `Surgery.urgency` | `ELECTIVE` | "ELECTIVE" \| "URGENT" \| "EMERGENCY" | Native enum |
| `SurgerySchedule.status` | `SCHEDULED` | "SCHEDULED" \| "CANCELLED" | Native enum |
| `AnesthesiaRecord.status` | `PLANNED` | "PLANNED" \| "IN_PROGRESS" \| "COMPLETED" | Native enum |
| `SurgicalSpecimen.status` | `COLLECTED` | "COLLECTED" \| "SENT" \| "RECEIVED" | Native enum |
| `RecoveryRecord.status` | `PENDING` | "PENDING" \| "IN_RECOVERY" \| "READY_FOR_TRANSFER" \| "TRANSFERRED" | Native enum |
| `NursingAssessment.status` | `DRAFT` | "DRAFT" \| "COMPLETED" \| "SIGNED" \| "SUPERSEDED" | Native enum |
| `BloodUnit.bloodGroupStatus` | `PENDING` | "PENDING" \| "CONFIRMED" — set only from an authorized typing record | Native enum |
| `BloodTypingRecord.status` | `PENDING` | "PENDING" \| "RESULTED" \| "VERIFIED" | Native enum |
| `BloodCompatibilityTest.testType` | `CROSSMATCH` | "TYPE_AND_SCREEN" \| "CROSSMATCH" | Native enum |
| `BloodIssue.status` | `ISSUED` | "ISSUED" \| "IN_TRANSIT" \| "RECEIVED" \| "RETURNED" | Native enum |

**Hospital billing, supply chain**

| Column | Default | Values | Verdict |
|---|---|---|---|
| `Charge.category` | — | CONSULTATION \| BED \| PROCEDURE \| LAB \| IMAGING \| PHARMACY \| NURSING \| PACKAGE \| OTHER | Native enum |
| `Charge.currency` | `INR` | _defined in code_ | ISO 4217 currency code — an external, open code set. Keep text; add a 3-letter CHECK. |
| `Tariff.currency` | `INR` | _defined in code_ | ISO 4217 currency code — an external, open code set. Keep text; add a 3-letter CHECK. |
| `PackageDefinition.currency` | `INR` | _defined in code_ | ISO 4217 currency code — an external, open code set. Keep text; add a 3-letter CHECK. |
| `Invoice.currency` | `INR` | _defined in code_ | ISO 4217 currency code — an external, open code set. Keep text; add a 3-letter CHECK. |
| `Payment.currency` | `INR` | _defined in code_ | ISO 4217 currency code — an external, open code set. Keep text; add a 3-letter CHECK. |
| `PurchaseOrder.currency` | `INR` | _defined in code_ | ISO 4217 currency code — an external, open code set. Keep text; add a 3-letter CHECK. |
| `SupplierContract.currency` | `INR` | _defined in code_ | ISO 4217 currency code — an external, open code set. Keep text; add a 3-letter CHECK. |
| `DepartmentSupplyRequest.urgency` | `ROUTINE` | _defined in code_ | Native enum |

**Operations: housekeeping, diet, transport, assets**

| Column | Default | Values | Verdict |
|---|---|---|---|
| `HousekeepingRequest.priority` | `ROUTINE` | "ROUTINE" \| "URGENT" \| "STAT" | Native enum |
| `HousekeepingRequest.status` | `REQUESTED` | REQUESTED\|ASSIGNED\|IN_PROGRESS\|COMPLETED\|INSPECTED\|CLOSED\|CANCELLED | Native enum |
| `DietOrder.status` | `ACTIVE` | ACTIVE \| DISCONTINUED \| CANCELLED | Native enum |
| `Meal.status` | `PLANNED` | PLANNED\|PREPARING\|READY\|DELIVERED\|REFUSED\|MISSED\|CANCELLED | Native enum |
| `PatientTransportRequest.priority` | `ROUTINE` | _defined in code_ | Native enum |
| `PatientTransportRequest.status` | `REQUESTED` | REQUESTED\|ACCEPTED\|ASSIGNED\|EN_ROUTE_TO_PICKUP\|PATIENT_PICKED_UP\|IN_TRANSIT\|ARRIVED\|COMPLETED\|CANCELLED\|REJECT | Native enum |
| `Ambulance.status` | `AVAILABLE` | AVAILABLE \| ON_TRIP \| MAINTENANCE \| OUT_OF_SERVICE | Native enum |
| `AmbulanceTrip.status` | `REQUESTED` | REQUESTED\|DISPATCHED\|EN_ROUTE\|AT_PICKUP\|PATIENT_ONBOARD\|IN_TRANSIT\|ARRIVED\|COMPLETED\|CANCELLED\|FAILED_DISPATCH | Native enum |
| `MaintenanceRequest.priority` | `ROUTINE` | _defined in code_ | Native enum |
| `MaintenanceRequest.status` | `REPORTED` | REPORTED\|TRIAGED\|ASSIGNED\|IN_PROGRESS\|RESOLVED\|VERIFIED\|CLOSED\|CANCELLED | Native enum |
| `PreventiveMaintenance.status` | `SCHEDULED` | SCHEDULED \| DONE \| CANCELLED | Native enum |
| `AssetDowntime.status` | `ACTIVE` | ACTIVE \| RESOLVED | Native enum |
| `BiomedicalEquipment.status` | `IN_SERVICE` | IN_SERVICE \| UNDER_MAINTENANCE \| OUT_OF_SERVICE \| RETIRED | Native enum |

**Quality and infection control**

| Column | Default | Values | Verdict |
|---|---|---|---|
| `InfectionIncident.status` | `REPORTED` | REPORTED\|UNDER_REVIEW\|INVESTIGATION\|ACTION_REQUIRED\|RESOLVED\|CLOSED\|CANCELLED | Native enum |
| `InfectionInvestigation.status` | `OPEN` | OPEN \| COMPLETED | Native enum |
| `ExposureRecord.status` | `DOCUMENTED` | DOCUMENTED \| REVIEWED | Native enum |
| `QualityIncident.category` | — | documentary: MEDICATION\|FALL\|PRESSURE_INJURY\|DIAGNOSTIC\|SURGICAL\|TRANSFUSION\|INFECTION\|EQUIPMENT\|OPERATIONAL\|S | Documentary taxonomy that organizations extend. Keep text; validate via configuration. |
| `QualityIncident.severity` | `MODERATE` | LOW\|MODERATE\|HIGH\|CRITICAL (organizational classification, not a computed score) | Native enum |
| `QualityIncident.confidentiality` | `STANDARD` | STANDARD\|RESTRICTED | Native enum |
| `QualityIncident.status` | `REPORTED` | REPORTED\|TRIAGED\|UNDER_INVESTIGATION\|ACTION_REQUIRED\|RESOLVED\|CLOSED\|CANCELLED | Native enum |
| `RootCauseAnalysis.methodology` | `FIVE_WHYS` | FIVE_WHYS\|FISHBONE\|OTHER (documentary — the system stores, does not infer) | Native enum |
| `RootCauseAnalysis.status` | `DRAFT` | DRAFT\|UNDER_REVIEW\|REVIEWED | Native enum |
| `CapaAction.actionType` | — | CORRECTIVE\|PREVENTIVE | Native enum |
| `CapaAction.status` | `OPEN` | OPEN\|IN_PROGRESS\|COMPLETED\|VERIFIED\|CLOSED\|CANCELLED | Native enum |
| `QualityStandard.status` | `ACTIVE` | ACTIVE\|ARCHIVED | Native enum |
| `QualityMeasure.status` | `PENDING` | PENDING\|COMPLIANT\|PARTIAL\|NON_COMPLIANT\|NOT_APPLICABLE | Native enum |
| `ComplianceEvidence.evidenceType`? | — | POLICY\|PROCEDURE\|REPORT\|TRAINING\|RECORD\|INVESTIGATION\|OTHER | Native enum |
| `QualityFinding.sourceType`? | — | AUDIT\|STANDARD\|MEASURE\|INCIDENT\|OTHER | Native enum |
| `QualityFinding.severity`? | — | LOW\|MODERATE\|HIGH\|CRITICAL | Native enum |
| `QualityFinding.status` | `OPEN` | OPEN\|IN_PROGRESS\|CLOSED | Native enum |
| `QualityAudit.status` | `PLANNED` | PLANNED\|IN_PROGRESS\|COMPLETED\|CLOSED | Native enum |

**Workforce**

| Column | Default | Values | Verdict |
|---|---|---|---|
| `WorkforceAssignment.assignmentType` | `PRIMARY` | PRIMARY\|SECONDARY\|TEMPORARY | Native enum |
| `WorkforceAssignment.status` | `ACTIVE` | ACTIVE\|ENDED | Native enum |
| `StaffAvailability.availability` | `AVAILABLE` | AVAILABLE\|UNAVAILABLE\|ON_LEAVE\|SUSPENDED\|OFF_DUTY | Native enum |
| `StaffShift.shiftType`? | — | DAY\|NIGHT\|EVENING\|ON_CALL | Native enum |
| `StaffShift.status` | `SCHEDULED` | SCHEDULED\|CANCELLED\|COMPLETED | Native enum |
| `StaffingRequirement.status` | `ACTIVE` | ACTIVE\|ARCHIVED | Native enum |
| `Credential.credentialType` | — | REGISTRATION\|QUALIFICATION\|CERTIFICATION\|LICENSE\|SPECIALTY\|TRAINING | Native enum |
| `Credential.status` | `PENDING` | PENDING\|VERIFIED\|EXPIRED\|SUSPENDED\|REVOKED | Native enum |
| `StaffPrivilege.privilegeType` | — | e.g. SURGERY\|ANESTHESIA\|BLOOD_BANK_VERIFY\|LAB_RESULT_VERIFY\|RADIOLOGY_REPORT_FINALIZE\|ICU_RESPONSIBILITY\|PHARM | Facility-defined privilege catalogue ("e.g. …" in the schema). Keep text; validate against a configured list. |
| `StaffPrivilege.status` | `ACTIVE` | ACTIVE\|EXPIRED\|SUSPENDED\|REVOKED | Native enum |

**Interoperability: ABDM, NHCX, identifiers**

| Column | Default | Values | Verdict |
|---|---|---|---|
| `ExternalIdentifier.entityType` | — | PATIENT \| FACILITY \| STAFF \| ENCOUNTER \| ORGANIZATION \| DOCUMENT | Native enum |
| `ExternalIdentifier.use` | `OFFICIAL` | OFFICIAL \| SECONDARY \| OLD | Native enum |
| `ExternalIdentifier.status` | `ACTIVE` | ACTIVE \| SUPERSEDED \| REVOKED \| INVALID | Native enum |
| `ExternalIdentifier.source` | `LOCAL_ENTRY` | LOCAL_ENTRY \| REGISTRY_LOOKUP \| IMPORTED | Native enum |
| `ExternalIdentifier.verificationStatus` | `UNVERIFIED` | UNVERIFIED \| VERIFIED \| FAILED | Native enum |
| `InteropConsent.purpose` | — | TREATMENT \| REFERRAL \| SECOND_OPINION \| INSURANCE \| PATIENT_ACCESS \| RESEARCH \| OTHER | ABDM consent purpose — external vocabulary. Keep text, validated against the contract module. |
| `InteropConsent.status` | `REQUESTED` | REQUESTED \| GRANTED \| ACTIVE \| EXPIRED \| REVOKED \| DECLINED \| CANCELLED | Native enum |
| `InteropConsent.recipientType` | — | FACILITY \| ORGANIZATION \| PRACTITIONER \| PATIENT \| EXTERNAL_SYSTEM | Native enum |
| `InteropConsent.source` | `LOCAL` | _defined in code_ | Native enum |
| `InteropConsentScope.scope` | — | ALL_CLINICAL \| DIAGNOSIS \| LAB \| IMAGING \| MEDICATION \| DOCUMENTS \| ENCOUNTER \| ALLERGY \| VITALS \| CARE_PLAN \| | Maps to ABDM HI types — external vocabulary that ABDM extends. Keep text. |
| `HealthInformationExchange.direction` | — | OUTBOUND \| INBOUND | Native enum |
| `HealthInformationExchange.status` | `REQUESTED` | REQUESTED \| AUTHORIZED \| PROCESSING \| COMPLETED \| REJECTED \| FAILED \| CANCELLED | Native enum |
| `HealthInformationExchange.abdmProtocolState`? | — | NOT_SUBMITTED \| SUBMITTED \| ACKNOWLEDGED \| GRANTED \| DENIED \| EXPIRED \| ERRORED | Mirrors ABDM protocol states — external spec. Keep text. |
| `InteropProvenance.direction` | — | OUTBOUND \| INBOUND | Native enum |
| `InteropProvenance.dataOrigin` | — | LOCAL \| EXTERNAL \| IMPORTED \| MAPPED \| DERIVED | Native enum |
| `ImportedResource.status` | `RECEIVED` | RECEIVED \| MAPPED \| IMPORTED \| REJECTED \| CONFLICT | Native enum |
| `TerminologyMapping.domain` | — | DIAGNOSIS \| LAB \| MEDICATION \| OBSERVATION \| PROCEDURE \| UNIT | Native enum |
| `TerminologyMapping.status` | `ACTIVE` | ACTIVE \| RETIRED | Native enum |
| `InteropConnection.system` | — | ABDM \| HFR \| HPR \| NHCX | Native enum |
| `InteropConnection.environment` | `DISABLED` | DISABLED \| SANDBOX \| PRODUCTION | Native enum |
| `InteropConnection.status` | `NOT_CONFIGURED` | NOT_CONFIGURED \| CONFIGURED \| ERROR | Native enum |
| `IntegrationCertificate.role`? | `CURRENT` | _defined in code_ | Native enum |
| `IntegrationCertificate.status` | `NOT_CONFIGURED` | _defined in code_ | Native enum |
| `ExternalParticipant.environment` | `SANDBOX` | _defined in code_ | Native enum |
| `ExternalParticipant.status` | `ACTIVE` | _defined in code_ | Native enum |
| `ExternalParticipant.trustStatus` | `UNVERIFIED` | _defined in code_ | Native enum |
| `IntegrationAlert.severity` | `WARNING` | INFO \| WARNING \| CRITICAL | Native enum |
| `IntegrationAlert.status` | `OPEN` | _defined in code_ | Native enum |
| `AbdmCallbackEvent.status` | `ACCEPTED` | _defined in code_ | Native enum |
| `ClaimSubmission.submissionType` | `ORIGINAL` | _defined in code_ | Native enum |
| `ClaimSubmission.status` | `DRAFT` | _defined in code_ | Native enum |
| `NhcxExchange.direction` | `OUTBOUND` | _defined in code_ | Native enum |
| `NhcxExchange.protocolState` | `NOT_SUBMITTED` | _defined in code_ | Mirrors NHCX protocol states; the NHCX contract is not yet verified (see nhcx/adapter.ts). Keep text until it is. |
| `NhcxCallbackEvent.status` | `ACCEPTED` | _defined in code_ | Native enum |
| `ClaimQuery.status` | `RECEIVED` | _defined in code_ | Native enum |
| `ClaimSettlement.status` | `NOTIFIED` | _defined in code_ | Native enum |
| `ReconciliationException.severity` | `WARNING` | INFO \| WARNING \| CRITICAL | Native enum |
| `ReconciliationException.status` | `OPEN` | _defined in code_ | Native enum |

**Privacy, patient access, notifications**

| Column | Default | Values | Verdict |
|---|---|---|---|
| `BreakGlassAccess.status` | `ACTIVE` | _defined in code_ | Native enum |
| `PrivacyRequest.status` | `REQUESTED` | _defined in code_ | Native enum |
| `PatientDelegation.relationship` | — | PARENT \| CHILD \| SPOUSE \| GUARDIAN \| CAREGIVER \| OTHER | Native enum |
| `PatientDelegation.status` | `INVITED` | _defined in code_ | Native enum |
| `PatientAccessSession.status` | `PENDING` | _defined in code_ | Native enum |
| `Notification.category` | `OPERATIONAL` | CLINICAL \| OPERATIONAL \| ADMINISTRATIVE \| SYSTEM | Native enum |
| `Notification.priority` | `ROUTINE` | ROUTINE \| URGENT \| CRITICAL | Native enum |

### 8.3 Student verification uploads → the storage adapter

`src/lib/verification/provider.ts` (`MockVerificationProvider`) predates
`StorageAdapter` (Phase 1.1) and keeps its own store. ADR 0003 records this
as a known divergence. The problems:

- **An absolute filesystem path is persisted as `storageRef`.**
  `VerificationDocument.storageRef` is `path.join(process.cwd(), ".data/
  verification-uploads", …)`. It breaks if the working directory changes, and
  on Vercel's ephemeral, per-instance disk, where the file is gone after the
  request.
- **No upload validation.** `POST /api/student/register` stores any file
  type and size. The adapter's `verification` bucket already enforces an
  allow-list (PDF/JPEG/PNG/WebP), magic-byte sniffing and 15 MB.
- **It never reaches S3 or Supabase Storage,** so staging and production
  would lose the documents.
- **There is no read path.** Nothing reads the files back. A reviewer route
  is needed anyway, and should use `signedDownloadUrl` with an audit event.

**Plan (Week 2, not done now):**
1. Implement `VerificationProvider` on top of `getStorageAdapter()`: bucket
   `verification`, scope `studentProfileId`, through `validateUpload`.
2. Store the logical `storageRef` (`verification/<scope>/<sha16>-<name>`).
3. Write a one-off script that re-uploads existing local files and rewrites
   their refs, verifying the sha256 of each.
4. Add a gate that rejects a disallowed type, round-trips a PDF and
   refuses a path-style ref.
