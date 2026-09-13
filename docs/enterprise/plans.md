# Plans (Phase D2)

## What a plan is

A `SubscriptionPlan` is a commercial offering, platform-controlled. An
organization administrator can never create or edit one.

```prisma
model SubscriptionPlan {
  code            String  @unique   // stable slug used in APIs
  name, description
  status          SubscriptionPlanStatus  // ACTIVE | DEPRECATED | RETIRED
  billingInterval BillingInterval         // MONTHLY | QUARTERLY | YEARLY | NONE
  isDefault       Boolean                 // the internal grandfather plan
  version         Int                     // bumped on every entitlement edit
  entitlements    PlanEntitlement[]
}
```

## The catalogue (code)

Defined in `src/lib/commercial/registry.ts` and materialised by the bootstrap:

| code | max_facilities | max_users | modules |
| --- | --- | --- | --- |
| `starter` | 1 | 25 | Hospital OS only |
| `professional` | 5 | 500 | + advanced pharmacy/diagnostics, ICU, OT, blood bank, ED, inventory, quality, ABDM, enterprise control plane |
| `enterprise` | unlimited | unlimited | everything |
| `aarogya-default` (grandfather, `isDefault`) | unlimited | unlimited | everything — preserves pre-D2 access; not a sold contract |

Plan names are data, not hard-coded logic — nothing branches on `plan.code ===
"enterprise"` anywhere (the evaluator resolves values, never plan names).

## Versioning & snapshot immutability

Editing a plan's entitlement (`setPlanEntitlement`) increments `version` and is
audited (`commercial.planEntitlement.changed`). It does **not** retroactively
change existing subscribers, because each `OrganizationSubscription` carries its
own `SubscriptionEntitlement` snapshot taken at subscribe/assign time. A
subscriber only picks up new plan values when their subscription is explicitly
re-assigned. This is proven by the gate ("existing subscriber keeps
advanced_pharmacy after the plan edit").

## Lifecycle

`RETIRED` plans cannot be assigned to new subscriptions; existing subscribers on
them keep their snapshot. `updatePlan` handles name/description/status; status
changes emit `commercial.plan.statusChanged`.

## APIs (platform, except catalogue read)

- `GET  /api/hospital/enterprise/commercial/plans` — catalogue (any `commercial:read`)
- `POST /api/hospital/enterprise/commercial/plans` — create (platform)
- `PATCH /api/hospital/enterprise/commercial/plans/{planId}` — update/status (platform)
- `PUT  /api/hospital/enterprise/commercial/plans/{planId}/entitlements` — set a plan entitlement (platform)
