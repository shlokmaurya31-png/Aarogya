# Versioning, Publication & Effective Dates

## Publication boundary (§32)

Editing configuration lands as a **DRAFT** (version 0) and does **not** affect
runtime. Only a **PUBLISHED** value is live. This guarantees editing never silently
mutates behavior before validation/publication.

```
DRAFT (edit freely) → PUBLISH (validated, versioned, effective-dated) → live
                    → RESET → RETIRED (inherit again)
```

## Versioning

Publishing assigns the next integer version (`max(published/retired)+1`) and makes
the row PUBLISHED. Version numbers are unique per `(scope, scopeRef, key)`
(DB-enforced). Immutable history is recorded in `ConfigurationChange` (SET / PUBLISH
/ RESET) with old/new value, version, actor, reason, timestamp.

## Race safety

- **Publish** flips the draft with a guarded `updateMany WHERE status='DRAFT'`, so
  two concurrent publishes cannot both win — exactly one active version, no duplicate
  version (gate Races 2 & 7).
- **Draft edits** converge to one draft row (gate Race 1).
- **Reset vs update** reaches a deterministic state (gate Race 3).

## Effective dates (§13)

`publishOverride` accepts an `effectiveFrom` (default now; past clamped to now — no
retroactive change). Publishing bounds the previous open value's `effectiveUntil` to
the new `effectiveFrom`, so windows never overlap. A scheduled (future) publish that
would overlap an existing scheduled change is rejected (gate Race 4). The resolver
selects the value effective at the requested time:

```
publish 10m now ; publish 20m effectiveFrom now+1h
→ resolve(now) = 10m ; resolve(now+2h) = 20m
```

## Historical explainability (§38)

Long-running operations snapshot the effective value/version they used. D7 workflows
resolve their SLA through D8 at instance execution and **snapshot** it on the SLA
timer, so a later config change never retroactively moves an in-flight deadline (gate
Race 5). See [workflows](workflows.md).
