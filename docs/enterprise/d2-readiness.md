# D2 readiness

## Status: PASS

Phase D2 (SaaS licensing, entitlements & subscription architecture) is
implemented, migrated on both engines, and verified on real PostgreSQL 16.
It is domain architecture — **not** production billing readiness, and **no**
payment provider connectivity was performed.

## What shipped

- Commercial models: `SubscriptionPlan`, `EntitlementDefinition`,
  `PlanEntitlement`, `OrganizationSubscription`, `SubscriptionEntitlement`
  (per-subscription plan snapshot), `OrganizationEntitlementOverride`,
  `FacilityEntitlementOverride`.
- Code registry + plan catalogue; idempotent bootstrap that grandfathers existing
  tenants onto an explicit default plan.
- One authoritative entitlement evaluator (precedence + commercial-state gate +
  lazy expiry); `requireEntitlement` / `enforceLimit` (race-safe).
- Platform-only lifecycle, override and plan-management services; plan-edit
  snapshot immutability.
- Enterprise commercial control-plane API + `/hospital-os/enterprise/billing` UI.
- `commercial:*` permissions and `commercial.*` audit events.

## Verification

| Gate | Result |
| --- | --- |
| Prisma validate | clean |
| SQLite migration (applied) | clean, additive |
| PostgreSQL migration (replay from zero) | clean; **zero schema drift** |
| TypeScript / build | clean |
| Unit tests (`vitest run`) | 830/830 (incl. 16 new commercial) |
| D2 commercial gate — PostgreSQL 16 | **23/23** (security + semantics + 4 concurrency races) |
| D2 commercial gate — SQLite | 19/19 (concurrency skipped by design) |
| Regression: D1 tenancy (PG) | 41/0 |
| Regression: C4 trust-layer (PG) | 66/0 |
| Regression: C6 control plane (PG, fresh seed) | 140/0 |
| Regression: bed concurrency (PG) | 6/0 |

Reproduce the PG gate with `docs/PHASE_B_FINAL_INTEGRITY_GATE.md §7`, then
`npx tsx scripts/verify-postgres-commercial-entitlements.ts`.

## Integration with C4 / D1

Entitlement is layered after authorization and tenancy, never instead of them
(see [commercial-authorization](commercial-authorization.md)). Limit enforcement
is wired into the D1 `createFacility` (max_facilities + `hospital_os`) and
`addOrganizationMembership` (max_users) services; provisioning ensures a default
subscription. Safety-critical clinical access is not commercially gated.

## Remaining risks / notes

- Existing tenants are grandfathered onto `aarogya-default` (unlimited); real
  commercial limits apply only to organizations explicitly moved to a sold plan.
- No entitlement caching exists, so there is no stale-state window; if added later
  it must invalidate on plan/subscription/override changes.
- Self-service subscription management (an org admin cancelling/upgrading their
  own subscription) is intentionally NOT built — all mutation is platform-only.

## Deferred (D3+)

Payment provider integration (Stripe/Razorpay), webhooks, dunning, invoicing for
SaaS billing, proration, metered/usage-based billing beyond the two limits,
self-service checkout, entitlement caching, usage analytics. No such code,
fields, or fake provider data were added — only the `externalRef` boundary seam.
