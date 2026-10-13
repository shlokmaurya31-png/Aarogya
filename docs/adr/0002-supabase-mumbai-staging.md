# ADR 0002: Supabase (Mumbai, ap-south-1) for the staging database

- **Status:** Accepted
- **Date:** 2026-10-14

## Context

[ADR 0001](0001-postgres-single-database.md) made PostgreSQL the only
database. Staging needs a managed Postgres that:

- **Runs in India.** Aarogya is building toward ABDM integration and Indian
  health data; patient data is expected to stay in the country under the
  DPDP Act. Staging should run where production will, so latency, pooling
  behaviour and region constraints are exercised early.
- **Supports pgvector,** because RAG arrives in week 4 and the extension is
  already enabled by migration.
- **Offers connection pooling suited to serverless,** since the app runs on
  Vercel.
- **Ideally provides S3-compatible object storage in the same region,** for
  clinical documents and generated PDFs, behind the existing `StorageAdapter`
  and its `STORAGE_S3_*` variables.

We compared **Neon** and **Supabase**, the two managed Postgres services that
fit the existing Prisma + Vercel setup:

| Need | Neon | Supabase |
|---|---|---|
| India region | **None.** The nearest is Singapore. | **ap-south-1 (Mumbai)** |
| pgvector | Yes | Yes |
| Serverless pooling | Yes | Yes (Supavisor: transaction pooler on 6543, session pooler on 5432) |
| S3-compatible storage, same project and region | No | **Yes** (Supabase Storage, S3 protocol) |

## Decision

Use a **Supabase project in ap-south-1 (Mumbai)** for staging:

- **`DATABASE_URL`** is the transaction pooler (port 6543,
  `?pgbouncer=true`). The app and the seed use it.
- **`DIRECT_URL`** is the session pooler (port 5432). It is IPv4-reachable,
  and Prisma Migrate uses it through the `directUrl` datasource field.
  Locally, `DIRECT_URL` equals `DATABASE_URL`.
- **Credentials** live only in `.env.staging.local` (gitignored) and in
  Vercel's encrypted environment variables.
- **Operations** run through `npm run staging:migrate`, `staging:seed`
  (requires `STAGING_CONFIRM=yes`) and `staging:check`. See
  [docs/STAGING_SUPABASE.md](../STAGING_SUPABASE.md).
- **Migrations own all extensions.** `vector` is created in `public` by
  migration. It is never enabled from the dashboard, and `staging:check`
  enforces this.

## Consequences

**Benefits**

- Staging data stays in India, close to users and to the ABDM endpoints.
- Postgres, pgvector and S3-compatible storage come from one provider, in one
  region, with one set of credentials to manage.
- The two-URL setup (pooled for the app, session for Migrate) matches what
  production will need on serverless.

**Costs and risks**

- **Two URLs to keep consistent.** `staging:*` validates their shape: port
  6543 plus `pgbouncer=true` for `DATABASE_URL`, and not 6543 for
  `DIRECT_URL`.
- **Transaction pooling has limits.** There are no prepared statements, which
  `pgbouncer=true` handles, and no session-level state. Code must not rely on
  `SET` or advisory locks held across transactions. Our advisory lock is
  transaction-scoped (`pg_advisory_xact_lock`), which is compatible.
- **Dashboard-enabled extensions land in the `extensions` schema** and would
  conflict with our migrations. Mitigated by the rule and by `staging:check`.
- **Staging is not disposable.** `verify:all` refuses Supabase hosts outright,
  so the destructive gates can only run locally or in CI.
- **Lock-in is low.** Everything is plain Postgres plus pgvector, so moving
  providers means changing two URLs and re-running migrations.
- **Production's provider and region are not decided by this ADR.** A later
  ADR will decide them.
