# Architecture Decision Records

Short records of significant, hard-to-reverse decisions: the context, what we
decided, and what follows from it. An ADR is never rewritten after it is
accepted; a later ADR supersedes it.

File names are `NNNN-short-title.md`, numbered in order.

| # | Decision | Status | Date |
|---|----------|--------|------|
| [0001](0001-postgres-single-database.md) | Postgres is the single database and migration history | Accepted | 2026-10-13 |
| [0002](0002-supabase-mumbai-staging.md) | Supabase (Mumbai, ap-south-1) for the staging database | Accepted | 2026-10-14 |
| [0003](0003-adapters-for-external-services.md) | Every external service sits behind an adapter, switched on by env | Accepted | 2026-10-14 |
