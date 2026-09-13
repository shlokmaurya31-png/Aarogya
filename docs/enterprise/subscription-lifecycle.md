# Subscription lifecycle (Phase D2)

## States

`OrganizationSubscription.status` (distinct from D1's `OrganizationStatus` — a
tenant can be ACTIVE while its subscription is PAST_DUE):

`TRIAL · ACTIVE · PAST_DUE · GRACE · SUSPENDED · CANCELLED · EXPIRED`

One subscription per organization (`@unique organizationId`). Only the lifecycle
service mutates `status`; no other code does.

## Declared transitions

`src/lib/commercial/constants.ts` — a transition not listed is refused (400):

```
TRIAL     → ACTIVE, PAST_DUE, SUSPENDED, CANCELLED, EXPIRED
ACTIVE    → PAST_DUE, SUSPENDED, CANCELLED
PAST_DUE  → ACTIVE, GRACE, SUSPENDED, CANCELLED
GRACE     → ACTIVE, SUSPENDED, CANCELLED, EXPIRED
SUSPENDED → ACTIVE, CANCELLED, EXPIRED
CANCELLED → ACTIVE, EXPIRED
EXPIRED   → ACTIVE
```

All transitions are **platform-only** (`commercial:platform:manage`).

## Effective access per state

| State | Premium features | Notes |
| --- | --- | --- |
| TRIAL | enabled | server-set trial dates; lazily expires at `trialEndsAt` |
| ACTIVE | enabled | |
| PAST_DUE | enabled | soft state — a payment hiccup does not cut a hospital off |
| GRACE | enabled | explicit grace window (`gracePeriodEndsAt`) |
| SUSPENDED | **disabled** | data intact; not deleted |
| CANCELLED | **disabled** | immediate cancel |
| EXPIRED | **disabled** | end state |

Safety-critical clinical access is **never** gated by commercial state — that is
C4's job. Commercial gating applies only to premium FEATURE entitlements.

## Trials

`assignPlan({ trial: true })` sets `trialStartedAt = now` and `trialEndsAt = now +
trialDays` (default 14) **server-side**; no client timestamp is trusted. The
evaluator treats a trial past `trialEndsAt` as inactive even before a sweep
transitions it (proven by the gate).

## Cancellation

- **Cancel at period end** (`cancelSubscription({ immediate: false })`): sets
  `cancelAtPeriodEnd = true`; access continues until `currentPeriodEnd`, then the
  evaluator treats it as ended.
- **Immediate** (`{ immediate: true }`): transitions to `CANCELLED` now.

No organization data is deleted on cancellation.

## APIs (platform)

- `POST /api/hospital/enterprise/commercial/subscriptions` — assign a plan (with optional `trial`).
- `POST /api/hospital/enterprise/commercial/subscriptions/transition` — `action: "transition" | "cancel"`.
