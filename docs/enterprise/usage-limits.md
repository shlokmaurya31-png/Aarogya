# Usage & limits (Phase D2)

## Canonical usage (derived, never a drifting counter)

Usage is derived from canonical domain data, not a maintained counter:

- `max_facilities` usage = `count(Facility where organizationId, status != DEACTIVATED)`
- `max_users` usage = `count(OrganizationMembership where organizationId, status = ACTIVE)`

See `getUsage()` in `src/lib/commercial/summary.ts`. D2 deliberately does **not**
build a usage/analytics platform — only the authoritative counters needed to
enforce the two limits it ships.

## Server-side enforcement

Limits are enforced on the server, not by disabling a button:

- `createFacility` (D1 service) requires the `hospital_os` entitlement and calls
  `enforceLimit("max_facilities", …)`.
- `addOrganizationMembership` (D1 service) calls `enforceLimit("max_users", …)`.
  Only organization membership counts toward the user limit (a facility membership
  for an existing member adds no user).

`enforceLimit` (`src/lib/commercial/limits.ts`) also refuses when the
subscription is commercially inactive and audits denials (`commercial.limit.denied`).

## Race safety

`enforceLimit` runs the count-then-create in a **Serializable** transaction:

```
tx (Serializable):
  resolve limit (+ commercial-active check)
  n = count(current)          -- predicate read inside the tx
  if n + adding > limit: deny (403)
  create(...)
```

On PostgreSQL, two concurrent creations for the same organization that both read
`n = limit-1` conflict at commit; one aborts with `serialization_failure`, which
`withApiErrors` maps to a retryable **409**. On SQLite writers serialise, so the
second sees the committed count and is denied. Either way **exactly one
succeeds** — never `limit + 1`.

Proven by the PG gate: with a cap of 2 and 1 existing, 5 concurrent facility
creations (and 5 concurrent membership adds) each yield exactly one success and a
final count of 2.

## Limit denial vs concurrency loss

- Over the limit (business rule): `LimitExceededError` → **403**.
- Lost a genuine race: `serialization_failure`/`P2034` → retryable **409**.

These are distinguishable by clients, consistent with the Phase B error contract.
