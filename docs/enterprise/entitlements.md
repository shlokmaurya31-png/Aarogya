# Entitlements (Phase D2)

## The registry

Entitlements are a controlled, code-defined registry (`registry.ts`,
`EntitlementDefinition` in the DB). Each has a stable `key`, a `type`, a `scope`,
and a safe default.

Types:
- **BOOLEAN** — a capability flag (`advanced_pharmacy`).
- **LIMIT** — a numeric cap enforced against canonical usage (`max_facilities`);
  `unlimited` represents no cap.
- **NUMBER** — a numeric configuration value that is not a usage cap.

Scope:
- **ORGANIZATION** — evaluated once for the tenant (`hospital_os`, `nhcx_claims`,
  `max_facilities`, `max_users`, …).
- **FACILITY** — may additionally be overridden per facility (`icu`, `blood_bank`,
  `advanced_pharmacy`, …).

The D2 registry (14 keys): `hospital_os`, `enterprise_control_plane`,
`interoperability_abdm`, `nhcx_claims`, `advanced_pharmacy`,
`advanced_diagnostics`, `icu`, `operating_theatre`, `blood_bank`,
`emergency_department`, `inventory_procurement`, `quality_workforce`,
`max_facilities`, `max_users`. Deliberately small — a controlled registry, not
200 speculative flags.

## The evaluator — one authoritative engine

`src/lib/commercial/evaluator.ts` is the only place that answers "is org X
allowed capability Y (optionally at facility F)?". No `if (plan === ...)`
elsewhere.

### Resolution precedence (most specific first)

```
facility override → organization override → subscription snapshot → definition default
```

Expired overrides (`expiresAt` in the past) are ignored — expiry is derived from
the timestamp, never trusted from a status column.

### Commercial-state gate

`deriveCommercialState` computes whether the subscription is active **now**,
honouring lazy expiry (a `TRIAL` past `trialEndsAt`, or a `cancelAtPeriodEnd`
past `currentPeriodEnd`) even before a sweep transitions the row. For BOOLEAN
capabilities, `allowed = effectiveValue && commercialActive`: a
SUSPENDED/CANCELLED/EXPIRED subscription disables premium features (data intact,
safety-critical clinical access untouched).

### Return shape

```ts
{ key, type, allowed, value, limit, unlimited, source, commercialStatus, commercialActive, reason? }
```

Convenience: `hasEntitlement()` (BOOLEAN), `resolveLimit()` (LIMIT).

## Overrides

`OrganizationEntitlementOverride` / `FacilityEntitlementOverride` raise or lower
what a plan grants for a specific tenant/facility (e.g. an enterprise contract
lifts `max_facilities`, or one facility gets `icu` on a starter org). They are
**platform-only** — an org admin can never grant themselves one — explicit,
actor-stamped, optionally expiring, and audited, and never mutate plan or
subscription data.

## API

- `PUT/DELETE /api/hospital/enterprise/commercial/overrides` — set/remove an org
  or facility override (platform).
- entitlement evaluation is not a public endpoint; it is consumed internally by
  `requireEntitlement` / `enforceLimit` and surfaced read-only via the summary.
