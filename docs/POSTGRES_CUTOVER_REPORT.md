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

