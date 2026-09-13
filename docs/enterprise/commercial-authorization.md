# Commercial authorization (Phase D2)

## Entitlement is a separate layer from authorization

`hasEntitlement()` is **not** `authorize()`. The final access decision is:

```
C4 authorization  +  D1 tenancy  +  D2 entitlement
```

- C4 answers "may this actor perform this action on this patient/resource?"
- D1 answers "which organization/facility may this identity act in?"
- D2 answers "has the organization purchased this capability / is it within limits?"

Entitlement is checked **after** the C4/D1 checks (via `requireEntitlement` /
`enforceLimit`), never instead of them. A positive entitlement never grants
access C4/D1 would deny. Break-glass (C4) never touches entitlement, and a
commercial check never bypasses tenant isolation, RBAC, credentials, purpose or
consent.

## Permissions (least privilege)

Two `commercial:*` permissions:

| Permission | Roles | Purpose |
| --- | --- | --- |
| `commercial:platform:manage` | AAROGYA_ADMIN only | create/edit plans + entitlement values, assign/transition/cancel subscriptions, create/remove overrides |
| `commercial:read` | AAROGYA_ADMIN, HOSPITAL_ADMIN | view own organization's commercial state + usage |

Every commercial **mutation** is platform-only — enforced both at the route
(`requireActorMemberships("commercial:platform:manage")`) and in the service
(`requirePlatform(m)`). No clinical or non-admin role holds any `commercial:*`
permission.

## Why mutation is platform-only

It closes the self-service escalation attacks directly:

- an org admin **cannot** upgrade their own plan to Enterprise;
- an org admin **cannot** grant themselves an override;
- a facility admin **cannot** modify the organization subscription.

(All three are proven denied by the gate.) Org/facility admins get a read-only
view of their commercial state so the UI is useful without exposing controls.

## Tenant-scoped reads

`getCommercialSummary(m, organizationId)` calls `assertOrganizationAccess` (D1),
so a caller can only read the commercial state of an organization they belong to;
passing another org's id yields a 404-shaped denial. The `organizationId` passed
to the evaluator is always the D1-resolved tenant, never a raw client value.

## No caching

D2 introduces no entitlement cache — the evaluator reads current state every
time, so there is no stale-commercial-state window to invalidate. (If caching is
added later it must invalidate on plan, subscription and override changes; see
d2-readiness deferred work.)
