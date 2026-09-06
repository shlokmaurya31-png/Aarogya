# Phase 4.5 — PostgreSQL Validation & Core Integrity Gate

Small, tightly scoped infrastructure/integrity gate between Phase 4
(Diagnostics OS, Milestones A–E, `8de5f99`) and Phase 5. No new clinical
modules; no Phase 5 work. Closes four specific production blockers listed
in `docs/PHASE_4_PRODUCTION_READINESS.md` / `docs/PHASE_4_DIAGNOSTICS_ARCHITECTURE.md`
§12: Postgres was never actually tested, the radiology resource-scheduling
conflict check was a known SQLite-only race, `AuditEvent` had no facility/
patient columns, and `prisma db seed` had no production guard.

## 1. What the pre-gate audit found (before any code changed)

Two things the fix request's framing assumed but the codebase didn't
actually have yet:

- **Migration history was non-portable, not just "unverified."** 6 of the
  9 SQLite migrations (Phase 1/2/3, Milestones A/B/C) contain SQLite-only
  `PRAGMA`/table-rebuild SQL (`CREATE TABLE "new_X"` + `RENAME TO`).
  `prisma migrate deploy` with that history hard-fails on a fresh Postgres
  database — confirmed, not hypothetical.
- **`ImagingStudy` had no end-time/duration concept at all.** The old
  conflict check (`scheduleStudy`/`rescheduleStudy`) compared `resourceId`
  + exact-equal `scheduledAt`, not a real interval. Proving the requested
  test matrix (partial/contained overlap, half-open adjacency) required
  adding `scheduledEndAt` to the schema first.

No Docker/Postgres config or automated DB-backed/concurrency test
infrastructure existed in the repo before this gate. Every prior
concurrency claim in this codebase (Milestone C/E) was verified by firing
real parallel requests at a live dev server, not an automated test — this
gate follows the same convention (see §4).

## 2. PostgreSQL validation strategy

**One-time validation exercise producing a committed baseline artifact,
not a permanently-synced dual-schema system.** Prisma's `datasource
provider` must be a static literal (not env-driven) and its migrations
folder is fixed relative to whichever schema file is passed — a
zero-maintenance dual-provider setup isn't available without either a
hand-maintained second schema file (ongoing sync burden) or a one-time
swap. Since the project isn't cutting over to Postgres now and there's no
real Postgres production data to protect pre-launch, the lighter option
was used:

1. `prisma/schema.prisma`'s `datasource.provider` was temporarily flipped
   to `"postgresql"`.
2. `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`
   generated a fresh baseline reflecting the **current full schema** (all
   Phase 1–4 models plus this gate's new columns) — placed at
   `prisma/migrations-postgres-baseline/20260907000000_init/`. This is a
   separately tracked migration set, intentionally NOT derived from or
   merged into the SQLite `prisma/migrations/` history (which can't run on
   Postgres at all — see §1).
3. A second migration, `prisma/migrations-postgres-baseline/20260907000100_imaging_resource_no_overlap/`,
   adds the GiST exclusion constraint (§3).
4. Both migrations were applied via `prisma migrate deploy` against a
   local, throwaway `postgres:16-alpine` Docker container (isolated
   container/port/credentials, synthetic data only, never a shared or
   production database), followed by `prisma generate` and `npm run
   db:seed`.
5. Full verification ran live against that Postgres instance (§4).
6. `schema.prisma`'s provider was reverted to `"sqlite"` before finishing
   — local dev is unaffected; only the new
   `prisma/migrations-postgres-baseline/` folder and this doc are new.

**At real Postgres cutover**: regenerate `migrations-postgres-baseline/`
fresh from the then-current `schema.prisma` (repeat step 2 above) rather
than trying to keep it incrementally in sync before that point — this
project has no real Postgres data to protect until cutover actually
happens, so wholesale re-baselining is the simplest correct strategy, not
a shortcut. After cutover, treat that folder as the real migration history
going forward and switch to normal incremental `prisma migrate dev`.

## 3. Radiology scheduling — real interval + DB-level guarantee

**Schema**: `ImagingStudy.scheduledEndAt` (`DateTime`, required) added,
representing the half-open interval `[scheduledAt, scheduledEndAt)`.
Existing SQLite dev rows backfilled to `scheduledAt + 30min` in the
migration (synthetic dev data only).

**App-level fix** (`src/lib/hospital/imagingStudyLifecycle.ts`,
`scheduleStudy`/`rescheduleStudy`): the exact-timestamp-equality count
check was replaced with a real overlap query:
```
scheduledAt: { lt: newEnd }, scheduledEndAt: { gt: newStart }
```
Both functions accept an optional `durationMinutes` (default 30, exposed
on the `study/schedule` and `study/reschedule` API routes).

**DB-level backstop, Postgres only** (`imaging_resource_no_overlap`, in
the Postgres baseline): a GiST exclusion constraint —
```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "ImagingStudy" ADD CONSTRAINT "imaging_resource_no_overlap"
  EXCLUDE USING gist (
    "resourceId" WITH =,
    tsrange("scheduledAt", "scheduledEndAt", '[)') WITH &&
  )
  WHERE ("resourceId" IS NOT NULL AND "status" NOT IN ('CANCELLED', 'NO_SHOW'));
```
This is the actual fix for "two concurrent transactions can both pass a
count-then-create check" — the constraint is enforced atomically by
Postgres regardless of transaction interleaving. `scheduleStudy`/
`rescheduleStudy` catch the resulting exclusion violation (matched
defensively on the raw Postgres error text — Prisma has no first-class
`.code` mapping for EXCLUDE constraints, unlike `P2002` for `UNIQUE`) and
map it to the existing `ScheduleConflictError`.

**SQLite dev** keeps only the strengthened app-level interval check — no
exclusion-constraint equivalent exists on SQLite. This is an accepted,
documented gap, consistent with this codebase's existing SQLite/Postgres
guarantee split elsewhere (e.g. the `Appointment` model's own scheduling
conflict check, `src/lib/hospital/appointment.ts`, has the *same*
exact-timestamp-equality bug and the *same* SQLite-only guarantee — it was
explicitly out of scope for this gate, which was scoped to Radiology only.
Noted here as a follow-up, not fixed).

**Test matrix + genuine concurrency**: `scripts/verify-postgres-scheduling.ts`,
run manually against the live Postgres container (this codebase's
established "no automated DB test infra, verify via real parallel
requests" convention — §12.3 of the architecture doc did the same via
`curl`). All 8 cases pass:

| Case | Result |
|---|---|
| Exact collision (10:00–10:30 vs 10:00–10:30) | PASS — one rejected |
| Partial overlap (10:00–10:30 vs 10:15–10:45) | PASS — one rejected |
| Contained overlap (10:00–11:00 vs 10:15–10:30) | PASS — one rejected |
| Adjacent (10:00–10:30 vs 10:30–11:00) | PASS — both allowed |
| Different resources, same time | PASS — both allowed |
| Different facilities (tenant-scoped resources) | PASS — both allowed |
| Cancelled booking frees the resource | PASS — reused successfully |
| Genuine parallel race (`Promise.all`, same resource+window) | PASS — exactly one of two truly concurrent attempts committed |

Also verified live via real HTTP requests against the Postgres-backed dev
server (login → create imaging order → schedule with `durationMinutes`),
confirming the full route → RBAC → lifecycle-function → DB stack works
end-to-end, not just the direct-function test script.

## 4. AuditEvent context hardening

**Schema**: nullable, indexed `facilityId` (+ `Facility` relation),
`patientId` (+ `Patient` relation), `encounterId` (plain scalar, no
relation — a narrowing filter, not a hard integrity requirement) added to
`AuditEvent`. Historical rows left `null`, not backfilled — `detail` JSON
isn't structured consistently enough across all pre-existing call sites
for a genuinely deterministic backfill, and fabricating context would
violate the basic premise of an audit trail.

**Helper** (`src/lib/auth/audit.ts`): `recordAuditEvent` gained an
optional 4th parameter, `context?: { facilityId?; patientId?; encounterId? }`.

**Call-site sweep** — 57 call sites across the codebase:
- **54 Hospital OS routes** (`requireFacilityStaff`-scoped) — `facilityId`
  always available; `patientId`/`encounterId` either already in scope or
  read off an already-fetched record (no new queries added).
- **6 shared lifecycle-helper sites** (`src/lib/hospital/admission.ts`'s
  `admitPatient`/`transferPatient`/`initiateDischarge`/`finalizeDischarge`/
  `completeBedCleaning`, and `encounterStateMachine.ts`'s
  `transitionEncounter`) — context derived from already-fetched
  records inside the existing transaction/query where possible; one small
  additional fetch through an existing FK chain added only where nothing
  was already in scope (`transferPatient`, `initiateDischarge`).
- **9 non-hospital (Scholar-platform) sites** — left untouched, no
  facility/patient concept applies, except `patient/register/route.ts`
  which already computed both values and moved them from `detail` into
  `context`.

**Tenancy verified live**: drove real actions as `doctor1@amc-demo.aarogya`
(AMC facility) and `admin@noida-demo.aarogya` (Noida facility) against the
Postgres-backed dev server, then queried `AuditEvent` directly —
`facilityId`-scoped queries returned only that facility's rows (AMC: 4
rows, 0 cross-facility leakage; Noida: 1 row after driving a Noida action),
and system/student events with no patient context remained valid
(`patientId: null`, non-crashing).

## 5. Production seed guard

`prisma/seed.ts` now calls `assertSeedAllowed()` first thing in `main()`:
refuses to run when `NODE_ENV=production` unless `ALLOW_DATABASE_SEED=true`
is explicitly set (exit code 1, clear stderr message). Explicit opt-in was
chosen over a database-name/host string heuristic, since those are easy to
get wrong. Verified both branches against the live Postgres container:
`NODE_ENV=production` alone refuses (exit 1); adding
`ALLOW_DATABASE_SEED=true` proceeds (exit 0). Never run against a real
production database — none exists.

## 6. Verification summary

Standard suite (SQLite, no regressions vs. established baseline of 3
pre-existing lint errors / 18 warnings, all in files untouched by this
gate): `prisma validate`/`generate` — clean; `tsc --noEmit` — clean;
`vitest run` — 161/161 passing; `npm run lint` — 3 errors/18 warnings,
identical to baseline; `npm run build` — succeeds.

Postgres-specific (live, against the Docker container, reverted before
commit): fresh-database `migrate deploy` — succeeds; full Phase 1–4 login
+ order + schedule flow — verified via real HTTP requests; scheduling test
matrix — 8/8 passing including the genuine parallel race; seed guard —
both branches verified; audit tenancy — verified across two facilities.

## 7. Open items carried forward (not in scope for this gate)

- `Appointment`'s scheduling conflict check has the same
  exact-timestamp-equality bug as `ImagingStudy` had — same SQLite-only
  guarantee, not fixed here (see `src/lib/hospital/appointment.ts`'s own
  docstring and `docs/PATIENT_FLOW.md`).
- The seed re-run duplication issue (`seedData/hospital.ts`'s plain
  `.create()` calls duplicating demo diagnostic data if seed is re-run
  without `migrate reset` first) — a different concern from the
  production guard fixed here, still open (architecture doc §12.15).
- TLS, security headers, rate limiting, secret rotation, backups/DR,
  structured observability — infrastructure-layer, unchanged.

Per standing project discipline: **STOP here, do not begin Phase 5**
without the user explicitly asking for it in a future session.
