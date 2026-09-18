# Operations

## API surface (§34)

No generic arbitrary-key mutation endpoint; every write validates the key against the
registry.

| Route | Perm | Purpose |
|---|---|---|
| `GET /api/hospital/enterprise/configuration?organizationId=…` | `configuration:read` | List an org's overrides |
| `GET …/configuration/registry` | `configuration:read` | The key registry |
| `GET …/configuration/effective?key=…&organizationId=…[&facilityId&departmentId&atTime]` | `configuration:read` | Effective value + provenance (explainer) |
| `GET …/configuration/history?key=…&scope=…&organizationId=…` | `configuration:read` | Change history |
| `POST …/configuration/validate` | `configuration:manage` | Validate a value, no persist |
| `POST …/configuration/set` | `configuration:manage` | Create/update a DRAFT |
| `POST …/configuration/publish` | `configuration:publish` | Publish a draft (versioned, effective-dated) |
| `POST …/configuration/reset` | `configuration:reset` | Reset an override (inherit) |

Scope in the body is verified against the caller's D1 membership; it is not
authoritative on its own.

## Caching (§37)

An in-process cache of current-time resolved values, keyed by (org, deepest scope,
key), invalidated by a per-organization generation counter that is bumped on every
publish/reset. TTL is short and time-travel/fallback lookups bypass the cache, so a
change is reflected immediately and correctness never depends on stale config. Not
Redis; no distributed cache.

## UI (§35/§36)

A scoped admin panel (`ConfigurationPanel`) lets an authorized admin browse effective
values with provenance, set → publish → reset a key, and see the org's overrides. It
distinguishes SYSTEM / ORGANIZATION / FACILITY / DEPARTMENT sources. It is **not** a
drag-and-drop workflow builder. Domains surfaced correspond to registry-backed keys
only.

## Performance

Lookups are indexed (`(scope, scopeRef, key, status)`, `(status, effectiveFrom)`),
scope filtering is server-side, and resolution is bounded (≤ 4 levels). Oversized
config is rejected; no N+1 in the hot path (the cache serves current lookups).
