# Commercial model (Phase D2)

Phase D2 adds Aarogya's SaaS commercial control plane on top of the D1 tenancy
layer. It answers "what has this ORGANIZATION purchased, and what may it use?" —
entirely separate from the hospital revenue cycle (patients/insurers).

## The two billing domains never mix

| Hospital revenue cycle (pre-existing) | Aarogya SaaS commercial layer (D2) |
| --- | --- |
| Charge, BillingAccount, Payer, PayerPlan, Invoice, Payment, Claim | SubscriptionPlan, EntitlementDefinition, PlanEntitlement, OrganizationSubscription, SubscriptionEntitlement, EntitlementOverride |
| about a **patient / encounter / insurer** | about an **organization / plan / entitlement** |
| `billing:*` permissions | `commercial:*` permissions |
| `hospital.billing.*` / `hospital.claim.*` audit | `commercial.*` audit |

`PayerPlan` (a patient's insurance plan) is **not** a `SubscriptionPlan`.

## The layered decision

```
IDENTITY → ORGANIZATION → FACILITY → AUTHORIZATION (C4) → TENANCY (D1) → ENTITLEMENT (D2) → FEATURE ACCESS
```

Entitlement is evaluated **after**, and never instead of, C4 authorization and
D1 tenancy. A positive entitlement never grants access C4/D1 would deny; a
missing entitlement never bypasses tenant isolation. Safety-critical clinical
access is governed by C4, never gated by commercial state.

## Model overview

```
EntitlementDefinition (registry)      SubscriptionPlan  ──<  PlanEntitlement  >── EntitlementDefinition
        │                                    │
        │                              (assigned to)
        │                                    ▼
        └───────<  OrganizationSubscription  >──── Organization
                          │
                          ├── SubscriptionEntitlement   (snapshot of the plan at subscribe time)
                          │
        OrganizationEntitlementOverride / FacilityEntitlementOverride   (contractual overrides)
```

Registry + plan catalogue are **code** (`src/lib/commercial/registry.ts`); an org
admin can never invent an entitlement or plan.

## Bootstrap strategy (existing tenants keep working)

`ensureCommercialBootstrap()` (`src/lib/commercial/bootstrap.ts`) is idempotent
and:

1. materialises the entitlement definitions and plan catalogue;
2. gives every organization with no subscription an **explicit** commercial state
   on the internal **`aarogya-default` grandfather plan** (flagged `isDefault`,
   `billingInterval = NONE`, all modules + unlimited limits).

The grandfather plan preserves pre-D2 access; it is **not** the sold "Enterprise"
plan and fabricates no customer contract. It runs from `prisma/seed.ts` (dev/demo
and the PG gate) and is safe to run once in production. Tenant provisioning also
calls `ensureDefaultSubscription`, so a newly provisioned org is immediately
functional.

See: [plans](plans.md) · [entitlements](entitlements.md) ·
[subscription-lifecycle](subscription-lifecycle.md) · [usage-limits](usage-limits.md) ·
[commercial-authorization](commercial-authorization.md) ·
[billing-provider-boundary](billing-provider-boundary.md) · [d2-readiness](d2-readiness.md).
