# Configuration Security & Clinical Safety

## Configuration is not authorization (§5/§41)

C4 stays authoritative for access control. Configuration never produces
`config says ALLOW → access granted`. The final decision is always
`C4 authorization + effective configuration + domain invariants`. The registry
exposes **no** key that grants a platform/authorization/permission privilege
(verified), and `role.*` keys are advisory mappings only — final authorization
remains C4.

## Tenant isolation (§30)

Scope is server-derived, never client-authoritative. A facility/department must
belong to the stated organization or the request is refused (404-shaped). Verified:
Org A cannot read/write Org B config; cross-tenant injection (Org B facility under an
Org A id) is rejected; guessed ids reveal nothing; list/read/write are all
tenant-scoped; an outsider is denied.

## Authorization (§31)

`configuration:read` (scoped view), `configuration:manage` (edit drafts),
`configuration:publish` (make live), `configuration:reset` (inherit again),
`configuration:operate` (platform-only engine operation). Platform-only keys
(`spec.platformOnly`) can never be set by an org/facility admin even with
`configuration:manage`.

## Input-attack surface (rejected)

- **Arbitrary keys** → refused (closed registry).
- **Invalid/out-of-range typed values** → refused (per-key validator).
- **Executable / JS payloads in JSON** → refused (strict schema + unknown-key
  rejection).
- **Prototype pollution** (`__proto__`/`constructor` keys) → refused.
- **Secrets / PHI / blobs in JSON** → refused at any depth (D6 sensitive guard);
  string values are length-bounded and secret-scanned.
- **SQL injection through values** → structurally impossible: values are typed,
  parsed, and stored via the ORM, never interpolated into SQL (an injection string is
  simply an invalid value and rejected).

## Config-explosion bounds (§29)

Max overrides per scope (500), JSON ≤ 8 KB / depth ≤ 6 / arrays ≤ 100, durations ≤ 30
days, escalation ≤ 10 steps.

## Audit & no secret persistence

Every administrative act is audited and value-level history is kept in
`ConfigurationChange`; secrets are never stored in either (they are rejected before
persistence). See [audit](audit.md).
