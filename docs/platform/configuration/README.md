# Configuration Engine (Phase D8)

Aarogya has a **safe, versioned, tenant-aware configuration engine** so different
hospitals operate differently **without forking the codebase**. Hospital-specific
behavior lives in validated configuration, not scattered `if hospital === "X"` code.

```
AAROGYA CODE → CONFIGURATION ENGINE
  SYSTEM DEFAULT → ORGANIZATION → FACILITY → DEPARTMENT   (most specific wins)
  → EFFECTIVE CONFIG (value + provenance + version, at a point in time)
  → DOMAIN SERVICES (D7 workflows/SLAs, …) via the ONE resolver
```

## What it is / isn't

| Is | Isn't |
|---|---|
| A governed, typed, versioned config store + resolver | The Workflow Builder / a notification platform |
| A superset of the D1 KV (which stays for its keys) | A new billing / authorization / tariff engine |
| Deterministic inheritance with provenance | A rules programming language / arbitrary code/SQL |
| Effective-date scheduling + publication boundary | Real-time propagation guarantees / exactly-once |
| Historical explainability (D7 snapshots its SLA) | A distributed/external config service |

## Module map (`src/lib/config/`)

| File | Responsibility |
|---|---|
| `registry.ts` | The closed, typed key registry (exact keys + templated families) |
| `types.ts` | Value types, scopes, bounds, strict JSON schemas |
| `resolver.ts` | The ONE effective-value resolver + provenance + snapshot |
| `overrides.ts` | Draft → publish → reset lifecycle + immutable change history |
| `authz.ts` | Scope authorization (reuses D1/C4); platform-only keys stay platform |
| `cache.ts` | In-process cache with per-org generation invalidation |
| `seed.ts` | A demo org override proving the value proposition |

## Verification

- Unit tests: `src/lib/config/config.test.ts` (vitest).
- Gate: `scripts/verify-postgres-d8-configuration.ts` (PostgreSQL: 40 checks incl. 7
  races + multi-hospital + D7 snapshot; SQLite: 33, concurrency skipped by design).

See: [architecture](architecture.md), [registry](registry.md), [scopes](scopes.md),
[resolution](resolution.md), [versioning](versioning.md), [workflows](workflows.md),
[slas](slas.md), [rules](rules.md), [security](security.md), [audit](audit.md),
[operations](operations.md), [migration](migration.md).
