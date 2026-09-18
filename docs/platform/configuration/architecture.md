# Configuration Engine — Architecture (Phase D8)

D8 is a **safe, versioned, tenant-aware configuration engine** that lets different
hospitals operate differently **without forking Aarogya's codebase**. It separates a
configuration **definition** (the registry), the **effective value** (resolved by
scope + time), and **runtime domain state** (which stays in canonical models). It is
a configuration substrate — not a workflow builder, notification platform, rules
language, billing/authorization/tariff engine, or a new event system.

```
AAROGYA CODE → CONFIGURATION ENGINE
  scopes: SYSTEM DEFAULT → ORGANIZATION → FACILITY → DEPARTMENT (most specific wins)
  → EFFECTIVE CONFIG (value + provenance + version, at a point in time)
  → DOMAIN SERVICES (D7 workflows/SLAs, …) consume via the ONE resolver
```

## Repository audit — reuse vs new

| Primitive | Found | D8 decision |
|---|---|---|
| D1 `OrgConfigValue` / `FacilityConfigValue` / `DepartmentConfigValue` + `src/lib/enterprise/configuration.ts` | Yes — a minimal **untyped** hierarchical KV (3 keys, string default, dept→facility→org→default, delete-to-reset) | **Left intact.** It has no types, effective dates, versioning, publication, history, provenance-chain, or snapshots — insufficient for D8. D8 is a governed superset with its **own** store; D1's KV keeps serving its existing keys. New operationally-significant configuration goes through D8. |
| D1 tenant context (`tenantContext.ts`) | Yes | **Reuse** for scope access (`assertOrganizationAccess`, `assertFacilityAdmin`, `canAccessFacility`); never trust client scope. |
| C4 / RBAC (`permissions.ts`) | Yes | **Reuse**; add `configuration:*` permissions. C4 stays authoritative — configuration never grants access. |
| D7 workflow engine + version SLA (`sla.dueAfterSeconds` in the version config) | Yes | **Integrate:** D7 resolves the effective workflow SLA through the D8 resolver, snapshotting the resolved value on the SLA timer so history stays explainable. D7 keeps owning timer creation/execution. |
| D7 condition engine (`conditions.ts`) | Yes | **Reuse** its safe operator set for the bounded config rule format (no second rule language). |
| `SlaPolicy` / `hospital/sla.ts` | Yes (clinical-metric thresholds) | **Not replaced.** D8 SLA keys are the governed mechanism; clinical `SlaPolicy` is a separate concern. |
| `Department`, `Tariff`, `PackageDefinition`, `QueueEntry`, roles | Yes | **Not duplicated.** D8 configures parameters around them via registry keys; canonical identity/calculation stays in those models. |
| AuditEvent | Yes | **Reuse** for config admin operations (not for lookups). |
| D6 `sensitiveGuard` | Yes | **Reuse** to keep secrets/PHI out of JSON config. |

## D8 model (new, additive)

- **Registry** (`src/lib/config/registry.ts`) — the closed set of legal keys, each
  with a value type (`BOOLEAN|NUMBER|STRING|ENUM|DURATION|JSON`), allowed scopes,
  default, strict Zod schema, sensitivity, description, and `platformOnly`. Supports
  a few **templated key families** (e.g. `workflow.{key}.sla`). Arbitrary keys are
  refused.
- **`ConfigurationOverride`** — one governed value at one scope: `key`, `valueType`,
  `scope` (ORGANIZATION/FACILITY/DEPARTMENT), `scopeRef` (the concrete id),
  `organizationId` (tenant filter), `facilityId?`, `departmentId?`, `value` (string),
  `status` (DRAFT/PUBLISHED/RETIRED), `version`, `effectiveFrom`, `effectiveUntil?`,
  `reason?`. Tenant scope is a loose indexed reference enforced in the service layer
  (consistent with D6/D7); status/type are TEXT (D5/D6 convention, zero enum drift).
- **`ConfigurationChange`** — immutable history (SET/PUBLISH/RESET/RETIRE, old/new
  value, version, actor, reason, timestamp).

## Core guarantees

- **Deterministic resolution**: most-specific scope whose PUBLISHED value is
  effective at the requested time wins; else inherit; else the registry default.
  One authoritative resolver — modules never implement their own precedence.
- **Provenance**: every effective lookup can explain the full chain and the winning
  source + version.
- **Publication boundary**: edits land as DRAFT; only PUBLISHED values affect runtime,
  so editing never silently mutates live behavior before validation/publication.
- **Historical explainability**: long-running operations (D7 workflows) snapshot the
  effective value/version they used, so a later config change never retroactively
  moves an in-flight deadline.
- **Safety**: no arbitrary keys, no executable content, strict typed validation,
  bounded JSON size/depth, tenant isolation, and C4 remains authoritative.

## What D8 is not

Not the Workflow Builder, not a notification platform, not arbitrary code/SQL/rules,
not real-time propagation guarantees, not a distributed config service. Those are
later phases; D8 provides the durable, secure, explainable substrate they sit on.
