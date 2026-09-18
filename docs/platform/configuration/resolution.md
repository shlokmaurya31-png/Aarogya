# Effective Resolution & Provenance

There is **one** authoritative resolver (`resolveConfig` for actor-scoped callers;
`resolveEffectiveInternal` / `snapshotConfig` for trusted server-internal callers
like the D7 engine). Modules never implement their own precedence.

## Algorithm

`resolveConfig({ key, organizationId, facilityId?, departmentId?, atTime? })`:

1. validate the key against the registry (unknown → error);
2. establish + authorize the tenant scope (reads require membership);
3. build the chain DEPARTMENT → FACILITY → ORGANIZATION → SYSTEM;
4. at each level, load the PUBLISHED override whose effective window contains
   `atTime` (`effectiveFrom ≤ atTime < effectiveUntil|∞`), latest `effectiveFrom`;
5. the first present level wins; parse + type-validate its value;
6. return the effective value **with full provenance**.

## Result shape (§10/§11/§43)

```json
{
  "key": "workflow.critical_lab.sla",
  "value": 1800, "raw": "1800", "valueType": "DURATION",
  "source": "DEPARTMENT", "sourceId": "…", "version": 7,
  "inheritedFrom": "FACILITY",
  "atTime": "2026-09-19T…Z",
  "chain": [
    { "source": "DEPARTMENT", "present": true,  "raw": "1800", "version": 7 },
    { "source": "FACILITY",   "present": true,  "raw": "5400", "version": 3 },
    { "source": "ORGANIZATION","present": false, "raw": null },
    { "source": "SYSTEM",     "present": true,  "raw": "14400" }
  ]
}
```

The explainer answers *what value is active, where it came from, and why* — exposed
via `GET …/configuration/effective`.

## Caching

Current-time lookups use an in-process cache keyed by (org, deepest scope, key),
invalidated by a per-organization generation counter bumped on every write. Explicit
`atTime` (time-travel) and fallback-backed lookups bypass the cache, so correctness
never depends on stale configuration. See [operations](operations.md).
