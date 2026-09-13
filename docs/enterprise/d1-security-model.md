# D1 security model

## Threats and the controls that answer them

| Threat | Control | Proven by |
| --- | --- | --- |
| Cross-organization IDOR/BOLA | Tenant scope resolved before RBAC; reads scoped to member orgs; `assertOrganizationAccess/Admin` | gate: "Org A cannot read/config/admin Org B" |
| Cross-facility IDOR | `resolveFacilityForStaff` honours only accessible facilities; 404-shaped denial | gate: "A1 member cannot reach A2/B1" |
| Client-controlled scope | Effective tenant re-derived server-side; enterprise services derive org from the *resource* | gate: client-id manipulation cases |
| Tenant enumeration | Inaccessible/unknown facility both → identical 404 "Not found." | gate + error-shaping table |
| Privilege escalation | `enterprise:organization:manage` (coarse) + `assertOrganizationAdmin` (fine); facility admin cannot mint org admin or reach another org | gate: escalation cases |
| Self-granting | A caller cannot grant/elevate their own membership to admin (non-platform) | gate: self-grant guard |
| Orphaning a tenant | Last active org admin cannot be demoted/removed | gate: last-admin protection |
| Stale membership | Only ACTIVE memberships count; removal takes effect immediately | gate: "removed membership loses access" |
| Stale session | Existing C4 `tokenVersion` revocation, unchanged | C4 trust-layer gate |
| Suspended-tenant operation | Non-ACTIVE org/facility → 403 for non-platform | gate: lifecycle safety |
| Break-glass tenant escape | Break-glass is C4-only; never reaches the tenant layer | gate: break-glass isolation |
| Mass assignment | Zod-validated route inputs; services take typed args; org derived from resource | route schemas + service design |
| Duplicate/lost writes under load | DB unique constraints + transactional provisioning | PG concurrency gate |

## Deny-by-default posture

- An action missing from the C4 policy registry is denied.
- A facility a caller has no standing in is denied (404).
- Organization administration is **not** backfilled onto existing admins — it is
  an explicit grant.
- Reactivating a DEACTIVATED tenant is platform-only.

## Platform admin is not a clinical superuser

`AAROGYA_ADMIN` operates the platform (create/provision/administer tenants,
recover suspended ones) but holds no broad clinical write permission; every C4
clinical check still applies on top of tenant scope.

## Data safety

Suspension and deactivation set timestamps and change status only. No clinical or
financial data is deleted at any lifecycle transition; the concurrency gate
asserts the clinical structure survives a suspend/reactivate cycle.

## Verification

- `scripts/verify-postgres-enterprise-tenancy.ts` — 41/41 on PostgreSQL 16
  (security + concurrency), 38/38 on SQLite (security; concurrency reported
  skipped).
- `src/lib/enterprise/enterprise.test.ts` — 10 rule-pinning unit tests.
- Regression: C4 trust-layer 66/0, bed concurrency 6/0, C6 control plane 140/0 (PG).
