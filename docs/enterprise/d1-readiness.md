# D1 readiness

## Status: PASS

Phase D1 (multi-tenant enterprise architecture & organization control plane) is
implemented, migrated on both engines, and verified — including on real
PostgreSQL 16.

## What shipped

- Organization & facility **lifecycle** (ACTIVE/SUSPENDED/DEACTIVATED, plus
  PROVISIONING for facilities), no data deletion on any transition.
- Explicit **membership** model (`OrganizationMembership`, `FacilityMembership`)
  with a scope-local `isAdmin` flag; multi-facility access.
- **Tenant-context** resolver (`src/lib/auth/tenantContext.ts`) integrated into
  the two existing chokepoints (`requireFacilityStaff`, `buildAuthorizationActor`),
  so ~337 routes gained organization awareness + lifecycle enforcement with no
  route churn.
- **Hierarchical configuration** (dept → facility → org → default) with explicit
  overrides and reset-to-inherited.
- Transactional, idempotent **provisioning**.
- Enterprise **control-plane API** under `/api/hospital/enterprise/*` and a
  `/hospital-os/enterprise` **UI** (HOSPITAL_ADMIN & AAROGYA_ADMIN).
- `enterprise:*` permissions and `enterprise.*` audit events; `AuditEvent.organizationId`.

## Migration inventory (route coverage)

The central tenant mechanism was placed at `requireFacilityStaff`, which ~337
Hospital OS API routes already call, and at `buildAuthorizationActor`, which the
~10 C4-engine routes call. Both now derive the effective organization/facility
from persisted membership and enforce tenant lifecycle. No route was left relying
on an unvalidated client-supplied `facilityId`, because the resolver is the single
place that decides the effective facility. Individual clinical routes were not
rewritten (they did not need to be) — this is the documented, deliberate design,
not an implied claim that hundreds of files were edited.

## Verification results

| Gate | Result |
| --- | --- |
| Prisma schema validate | clean |
| SQLite migration (applied) | clean, data-preserving, idempotent backfill |
| PostgreSQL migration (replay from zero) | clean; **zero schema drift** (`migrate diff --exit-code` empty) |
| TypeScript (`tsc --noEmit`) | clean |
| `next build` | clean |
| Unit tests (`vitest run`) | 814/814 (incl. 10 new) |
| D1 tenancy gate — PostgreSQL 16 | **41/41** (security + concurrency) |
| D1 tenancy gate — SQLite | 38/38 (concurrency skipped by design) |
| Regression: C4 trust-layer (PG) | 66/0 |
| Regression: bed concurrency (PG) | 6/0 |
| Regression: C6 control plane (PG) | 140/0 |

Reproduce the PG gate with the procedure in
`docs/PHASE_B_FINAL_INTEGRITY_GATE.md §7`, then
`npx tsx scripts/verify-postgres-enterprise-tenancy.ts`.

## Remaining risks / notes

- `slug` is nullable (only so the pre-D1 default org could be backfilled without a
  table rebuild); provisioning always sets it. New tenants have stable slugs.
- Three demo staff seeded outside the `upsertStaffUser` helper have no explicit
  membership rows; they still reach their home facility via the primary-implicit
  rule. Cosmetic only.
- Enterprise routes use `requirePermission` + membership assertions (not the C4
  patient engine), matching the C6 control-plane pattern; they are tenant-scoped
  and audited but do not carry patient-oriented consent/relationship checks (which
  is correct — they administer tenancy, not clinical data).

## Deferred (D2+)

Subscription/licensing/metering, enterprise analytics/reporting, API marketplace,
workflow builder, enterprise AI, mobile redesign, new clinical modules. No such
fields/tables were added.
