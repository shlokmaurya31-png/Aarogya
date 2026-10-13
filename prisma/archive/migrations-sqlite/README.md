# Archived SQLite migration history — frozen

These are the SQLite migrations Aarogya used for local development until
13 October 2026. They are **frozen history**: kept for reference and audit,
**never applied again**, and never edited.

Postgres is now the only database. The single live migration history is
`prisma/migrations/`. Prisma does not read this folder: it is outside
`prisma/migrations`, and its `migration_lock.toml` (provider `sqlite`) no
longer matches the schema.

Why: [docs/adr/0001-postgres-single-database.md](../../../docs/adr/0001-postgres-single-database.md).
