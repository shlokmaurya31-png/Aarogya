# Database Production Readiness — Phase 0

Assessment of whether `prisma/schema.prisma` (currently SQLite,
946 lines, 40 models) can transition to PostgreSQL, and what else needs
attention before this database supports real hospital operations. **No
migration is performed in this phase** — this is the readiness assessment
the brief asked for, ahead of that decision.

## 1. SQLite-specific logic — what's actually there

Grepped for anything SQLite-specific in application code (not just the
schema): **none found**. All Prisma queries use the standard query API
(`findMany`, `$transaction`, etc.) with no raw SQL (`$queryRaw`/
`$executeRaw`) anywhere in `src/` — confirmed by grep. This is the best
possible starting position for a Postgres cutover: the ORM layer is the
only thing that needs to change.

**One real gotcha already hit and fixed this session**: Prisma resolves a
`sqlite` `file:` datasource path *relative to `schema.prisma`'s directory*,
not the process's working directory — this caused a real, confusing bug
during initial setup (a stray `prisma/prisma/dev.db` was created before
this was understood) and is now correctly documented in
`.env.example`/`.env`. Not a migration blocker (Postgres uses a full
connection URL, not a relative file path, so this class of bug cannot
recur after cutover) — noted so the same confusion doesn't resurface if
SQLite is used again for a different purpose (e.g. CI).

## 2. Schema portability

Every field type used (`String, Int, Float, Boolean, DateTime, Json`) has
a direct Postgres equivalent — this was a deliberate constraint applied
consistently while building both Scholar and Hospital OS (documented in
`docs/STUDENT_PLATFORM_ARCHITECTURE.md` §2.1 and carried through). The
datasource block change required for cutover is genuinely one line:

```prisma
datasource db {
  provider = "postgresql"   // was "sqlite"
  url      = env("DATABASE_URL")  // becomes a postgres:// URL
}
```

followed by `prisma migrate deploy` against a fresh Postgres instance (a
brand-new migration history is the cleanest path — see §6).

## 3. Transaction assumptions

Every multi-step mutation that must be atomic already uses
`prisma.$transaction()`: bed admission (`admitPatient`), transfer
(`transferPatient`), discharge finalization (`finalizeDischarge`), lab/
imaging result release (bundles the result row + order-status update),
billing charge creation (charge + bill upsert). This code was written
against SQLite's transaction semantics but uses only the
lowest-common-denominator Prisma transaction API — **no SQLite-specific
isolation-level assumption was made**, so behavior under Postgres should
match. This has **not been load-tested** under either engine — the
"prevents two concurrent admissions to the same bed" guarantee (see
`docs/DATA_MODEL_AUDIT.md`/`docs/SECURITY_AUDIT.md` S-05-adjacent) is
reasoned from Prisma's documented transaction isolation, not verified
with a concurrency test. **Recommended before production**: a concurrency
test (fire two simultaneous admission requests at the same bed, assert
exactly one succeeds) — SQLite's single-writer model would actually mask
a subtle Postgres-only race if one exists, so this test should run
against Postgres specifically once cutover happens.

## 4. Concurrency model differences (SQLite vs. Postgres) relevant here

- **SQLite**: single-writer, serializes all writes at the file level
  regardless of `$transaction` isolation level requested. This means the
  current dev/demo environment is *more* protective against races than
  Postgres will be by default — a bug that "works" today under SQLite
  could surface only after cutover. This is the single most important
  reason the concurrency test in §3 should be treated as a real
  pre-production task, not optional polish.
- **Postgres**: MVCC, real concurrent writers, default `READ COMMITTED`
  isolation. Prisma's `$transaction` calls in this codebase don't specify
  an explicit isolation level — they'll get Postgres's default. For the
  bed-admission race specifically, the "re-read status inside the
  transaction, fail if not `AVAILABLE`" pattern (`admitPatient` in
  `src/lib/hospital/admission.ts`) is the right defensive pattern
  regardless of isolation level, but should still be verified rather than
  assumed correct.

## 5. Missing indexes

`docs/DATA_MODEL_AUDIT.md` covers per-model detail; summarized here from a
performance-readiness lens. Indexes exist on the columns that matter for
Hospital OS's Command Center and worklist queries (`Bed.status`,
`Encounter.{facilityId,status,patientId}`, `LabOrder.status`,
`ImagingOrder.status`, `HospitalStaffProfile.facilityId`,
`ClinicalCase.{specialty,difficulty}`, `AuditEvent.{type,userId}`) — 30
`@@index` declarations total, reviewed and each traced to a real query
pattern in the route handlers (not speculative).

**Real gaps**:
- No composite index on `(Encounter.facilityId, Encounter.status)`
  together — the Command Center and worklist queries filter on both; two
  single-column indexes give the query planner less to work with than one
  composite index would, at current data volumes this is immaterial, at
  real hospital scale (thousands of encounters/day) it would matter.
- No index on `MedicationAdministration.{status, scheduledAt}` together —
  the Nursing task engine's "due now" query (`status: DUE, scheduledAt:
  {lte: now}`) would benefit from a composite index once administration
  volume is real.
- `Charge`/`Bill` have no index beyond their FK relations — fine at
  current scale, worth revisiting once billing reporting queries
  (date-range revenue aggregation, etc.) exist.

## 6. Migration strategy recommendation

**Do not attempt to carry SQLite migration history forward to Postgres.**
Prisma's migration files (`prisma/migrations/*/migration.sql`) are
generated in SQLite's SQL dialect (confirmed by inspecting
`20260901223827_init/migration.sql` and `20260902015042_hospital_os/migration.sql`
— both contain SQLite-flavored DDL). The correct path:

1. Stand up a fresh Postgres instance (local Docker or managed).
2. Point `DATABASE_URL` at it, flip the datasource `provider`.
3. Run `prisma migrate dev --name init` against the empty Postgres
   database to generate a fresh, Postgres-native migration history from
   the current `schema.prisma` (which, per §2, requires no field-type
   changes to be valid Postgres DDL).
4. Do **not** attempt to hand-port the SQLite migration SQL — regenerating
   from the schema is strictly safer and is what the schema was already
   written to support cleanly.
5. Re-run `npm run db:seed` against the fresh Postgres instance — the seed
   scripts are pure Prisma Client calls with no SQLite-specific behavior,
   confirmed by the same "no raw SQL" grep in §1.

## 7. JSON usage assessment

12 `Json` fields across the schema (enumerated in
`docs/DATA_MODEL_AUDIT.md`), each reviewed for whether it represents data
that *should* be relational instead:

- **Justified** (genuinely unstructured/variable-shape, appropriately
  `Json`): `ClinicalCase.{content,rubric,viva}` (Scholar case authoring
  content — shape varies by case, not queried field-by-field),
  `CaseAttempt.{revealedState,differential,prescriptions,score}` (attempt-
  scoped working state), `CaseAction.payload`, `AuditEvent.detail`,
  `ClinicalNote.content` (SOAP-style structured note, shape varies by
  note type), `Discharge.dischargeSummary`, `MedicationOrder.safetyFlags`.
- **None found that should be relational instead** — no case of "this
  Json field is actually always the same 3 keys and should be 3 real
  columns" was identified. JSON overuse is not a finding in this codebase.

## 8. Constraints and data-integrity gaps carried over from the data model audit

See `docs/DATA_MODEL_AUDIT.md` §9 for the full list
(plain-string audit-trail "foreign keys," `Float` for money, missing
`Room`/`EpisodeOfCare` entities, free-text fields that should be enums).
None of these are Postgres-migration blockers — they're schema-design
gaps that exist identically under either engine and should be addressed
as schema changes independent of the engine choice.

## 9. What's genuinely production-blocking vs. what can wait

**Blocking before any real (non-demo) deployment**:
- Cutover to Postgres itself (SQLite is explicitly a local-dev choice,
  not intended for concurrent multi-instance production use).
- The concurrency test from §3/§4.
- `Float` → `Decimal` for all money fields before real billing.

**Can reasonably wait for a later phase**:
- Composite indexes (add when real query volume justifies it).
- `Room` entity, `EpisodeOfCare` entity (add when the workflows that need
  them are actually built — no current route needs either).
- Tightening plain-string audit fields into real foreign keys (add before
  this data is relied on for compliance reporting, not before).
