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
| [0004](0004-events-over-direct-calls.md) | Modules sync through transactional domain events, not direct calls | Accepted | 2026-10-14 |

## Pending decisions

- **Cross-tenant admin action (break-glass).** Today every admin role is
  confined to its own scope: a platform admin creates GLOBAL medication
  links but cannot create ORGANIZATION links, and organization and facility
  admins never act outside their tenant. When an administrator genuinely
  needs to act inside another tenant, that will come as an explicit
  **break-glass mode**: a reason is required, access is time-limited, and
  every action is audited. It will not come as wider default permissions.
  It gets its own ADR when it's built.
