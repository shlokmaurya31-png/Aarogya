# Scopes & Inheritance

## Hierarchy

```
SYSTEM DEFAULT → ORGANIZATION → FACILITY → DEPARTMENT   (most specific overrides)
```

A `ConfigurationOverride` stores one value at one scope, identified by `scope`
(ORGANIZATION/FACILITY/DEPARTMENT) + `scopeRef` (the concrete organization/facility/
department id). `organizationId` is always stored for tenant filtering; `facilityId`/
`departmentId` are set as applicable. Only **explicit** overrides are stored — the
absence of a row means "inherit".

## Precedence (deterministic)

The resolver walks DEPARTMENT → FACILITY → ORGANIZATION → SYSTEM and the first level
with an effective PUBLISHED value wins. Example:

```
System default = 4h ; Org = 4h ; Facility A = 2h ; ICU = 30m
→ ICU resolves to 30m ; another dept in Facility A → 2h ; Facility B → 4h
```

The SYSTEM level is the registry default, or a caller-supplied fallback (e.g. a D7
workflow version's own SLA) when the key has no registry default.

## Tenant isolation

Scope is **server-derived**, never client-authoritative. A facility/department must
belong to the stated organization or the request is refused (404-shaped), which
blocks cross-tenant injection (an Org A admin cannot target Org B's facility even by
supplying its id). Reads require membership; writes require the corresponding admin
standing (org admin for ORGANIZATION; org/facility admin for FACILITY/DEPARTMENT).

## Reset / inherit (§12)

Reset **retires** the current published override at a scope (status RETIRED,
`effectiveUntil` = now) and drops any draft, so the scope falls back to the parent /
default. No fake "default" row is ever written — an inherited value is always
distinguishable from an explicit override by whether a row exists.
