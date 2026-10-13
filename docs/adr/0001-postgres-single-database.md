# ADR 0001: Postgres is the single database and migration history

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

Aarogya started on SQLite so local development needed no setup. Production
always targeted PostgreSQL. As a result, the repo kept two migration histories
for one schema:

- `prisma/migrations` (SQLite) was what `schema.prisma` declared and what local
  dev applied.
- `prisma/migrations-postgres-baseline` (Postgres) was what production would
  run. It was hand-mirrored from every SQLite change.

That cost us in several ways:

- **Every schema change was written twice**, and the copies could drift. CI ran
  two drift checks. The Postgres check needed a `sed` swap of the provider into
  a scratch copy of the schema, and the integrity-gate docs repeated that swap.
- **The guarantees we rely on most exist only in Postgres.** These are the GiST
  `EXCLUDE` constraints (`imaging_resource_no_overlap`,
  `surgery_schedule_no_overlap`, `tariff_no_overlap`, `staff_shift_no_overlap`)
  and genuine write concurrency. Day-to-day development never exercised them,
  because SQLite serializes writers.
- **SQLite and Postgres disagree on types and ordering.** For example, SQLite
  stores DateTime as integer milliseconds and has no real enums. Code that
  worked locally could behave differently in production.
- **Production `migrate deploy` was blocked**, because the schema's declared
  provider was `sqlite`.
- **Planned features need Postgres-only capabilities**, such as pgvector.

A local Postgres 16 + pgvector is now one command (`npm run db:up`, via docker
compose, which also creates the `aarogya_shadow` database). That removes the
original reason for SQLite.

## Decision

PostgreSQL is the only database in every environment: local, CI, preview and
production.

- `schema.prisma` declares `provider = "postgresql"` and
  `shadowDatabaseUrl = env("SHADOW_DATABASE_URL")`.
- `prisma/migrations` is the single migration history. It is the former
  `prisma/migrations-postgres-baseline`, moved unchanged.
- The SQLite history is frozen in `prisma/archive/migrations-sqlite/`. It is
  kept for audit and never applied or edited again.
- Applied migrations are never edited. Drift is fixed with a new migration.
- CI's migration-drift job checks only that one history, against a
  `pgvector/pgvector:pg16` service. The SQLite step and the provider `sed` swap
  are removed.

## Consequences

**Benefits**

- Each schema change is written once, and there is one drift check.
- Local dev runs on the same engine, constraints and concurrency semantics as
  production. The verification scripts run against the normal dev database,
  with no scratch schema.
- Production can run `prisma migrate deploy` directly.

**Costs**

- Local development needs Docker (or another Postgres 16). Contributors run
  `npm run db:up` once, and copy `DATABASE_URL` and `SHADOW_DATABASE_URL` from
  `.env.example`.
- Existing local `dev.db` SQLite data is not migrated. Developers re-seed
  Postgres with `npm run db:seed`.
- Postgres-specific behaviour the app relied on SQLite to hide is now visible.
  Examples are case-sensitive `LIKE`/`contains` and strict transaction
  isolation. Anything that surfaces is fixed in app code, not papered over.
- Docs written before this date describe the old paired-migration convention.
  They are left as historical record. `docs/FEATURE_BUILDOUT_LOG.md` notes the
  cut-over.
