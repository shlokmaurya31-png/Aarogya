# Configuration inheritance (Phase D1)

## Resolution order

A configuration value resolves most-specific-first:

```
department override  →  facility override  →  organization override  →  hard-coded default
```

Implemented in `resolveConfig` (`src/lib/enterprise/configuration.ts`).

## Overrides are rows; inheritance is the absence of a row

Only **explicit** overrides are stored, as rows in `OrgConfigValue` /
`FacilityConfigValue` / `DepartmentConfigValue` (each unique on
`(scopeId, key)`). The absence of a row at a level means "inherit from the level
above". `resetToInherited` **deletes** the row — it does not write a sentinel — so
an inherited value is always distinguishable from an override by whether a row
exists.

Every resolved value reports its provenance:

```ts
{ key, value, source: "department" | "facility" | "organization" | "default", explicit: boolean }
```

`explicit` is `false` only when the value came from the hard-coded default.

## The key registry is closed

Configurable keys live in a small closed registry (`CONFIG_KEYS` in
`constants.ts`), each with a hard-coded default and description. Storing an unknown
key is refused. This is a clean, extensible foundation — adding a setting is adding
one entry — not a generic settings engine, and not dozens of speculative options
(brief §13). D1 ships three example keys
(`appointment.defaultDurationMinutes`, `appointment.maxAdvanceDays`,
`billing.currency`).

## Worked example (verified by the gate)

```
Organization "appointment.defaultDurationMinutes" = 20
  resolve at facility (no facility override)  → 20  source=organization  explicit=true
Facility override = 30
  resolve at facility                          → 30  source=facility
reset facility
  resolve at facility                          → 20  source=organization
Department override = 45
  resolve at department                        → 45  source=department
unset key "billing.currency"
  resolve                                      → INR source=default      explicit=false
```

## Authorization & audit

Reads require access to the tenant being resolved (`enterprise:config:read` +
membership). Writes require administration of the scope
(`assertOrganizationAdmin` / `assertFacilityAdmin`). Every override and reset emits
`enterprise.config.overridden` / `enterprise.config.reset` with organization (and
facility) scope. Cross-tenant configuration is refused 404-shaped.
