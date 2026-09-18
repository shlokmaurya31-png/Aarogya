# Workflow Security & Privacy

## Tenant isolation

- Tenant scope (`organizationId`/`facilityId`) is always **server-derived** — from
  the triggering event or the authenticated caller — never taken from client input.
- Instances inherit the event's organization/facility. An org admin can read only
  its own org's definitions/instances (global templates are readable; another org's
  org-scoped records return a 404-shaped denial). Guessed IDs reveal nothing.
- Cross-tenant read/manipulation/execution is refused (gate: cross-org definition +
  instance reads denied; instance list scoped to own org).

## Authorization (reuses C4/D1, no parallel RBAC)

- `workflow:read` — scoped read (platform + org/hospital admins).
- `workflow:manage` — author/version/publish/retire — **platform-only**.
- `workflow:operate` — cancel/retry/recover, engine ticks — **platform-only**.

Unauthorized create/version/publish/retire/cancel/retry by an org admin are refused
(403); an outsider cannot read instances (404). Verified in the gate.

## Clinical safety boundary / privilege escalation

A workflow action never gains clinical or financial authority. The action registry
exposes **no** clinical/financial mutation (verified by an assertion that no
order/prescribe/administer/dispense/payment/refund/discharge/delete/grant/merge
action exists). Any canonical mutation still runs behind its own domain service and
C4 authorization, consent, purpose, break-glass, and step-up rules. The workflow
engine is not an alternate privileged API.

## Input-attack surface (rejected at publication)

Unknown trigger event/version, unknown/non-invokable action, arbitrary condition
operator, executable-payload injection (unknown emit target), excessive nodes/
nesting, and invalid timer/retry values are all rejected by the strict schema +
validator before a definition can be published.

- **SQL injection through condition values** is structurally impossible: values are
  compared in memory, never interpolated into a query (verified inert in the gate).
- **organizationId / facilityId / patientId substitution**: scope is derived
  server-side; a client cannot assert another tenant's scope.

## Privacy / data minimization

- Conditions read only the allow-listed context; there is no arbitrary DB access.
- Workflow config and runtime metadata carry identifiers + minimal operational data.
  Emitted-event payloads pass through D6's `sensitiveGuard`, which rejects — at any
  depth — passwords, tokens, API keys, provider secrets, card data, and blob-length
  strings. A workflow that tries to emit a forbidden payload key FAILS and persists
  no secret (verified in the gate).

## Bounds (conservative)

`MAX_STEPS=20`, `MAX_CONDITION_DEPTH=5`, `MAX_CONDITION_NODES=40`,
`MAX_TIMER_SECONDS=30d`, `MAX_RETRIES=8`, `MAX_INSTANCE_DEPTH=5`.
