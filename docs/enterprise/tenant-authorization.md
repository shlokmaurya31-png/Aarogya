# Tenant authorization (Phase D1)

## How it integrates with C4

D1 did **not** create a second authorization or permission system. It added a
tenant-scope layer *around* the existing C4 pipeline, and derived the effective
tenant at the same server-side chokepoints C4 already used.

Conceptual request flow:

```
REQUEST
  ↓ authenticated session (HMAC cookie + tokenVersion revocation)  ── existing
  ↓ identity (userId, role)                                         ── existing
  ↓ ORGANIZATION + FACILITY scope (membership, lifecycle)           ── D1 (tenantContext)
  ↓ RBAC permission                                                 ── existing
  ↓ step-up  → relationship  → break-glass  → credential/privilege
    → purpose → consent                                             ── existing C4 engine
  ↓ ALLOW / DENY
```

Tenant scope is resolved **early** — before RBAC and before any resource lookup —
so a cross-tenant request looks identical to a nonexistent record regardless of
what permissions the caller holds. This is what prevents cross-tenant resource
*discovery*, not just cross-tenant *access*.

## The chokepoint: `src/lib/auth/tenantContext.ts`

Everything the tenant layer reasons about is read here from the session and the
database — never from a request body, query string, route parameter, FHIR payload
or ABDM callback. Key exports:

- `loadActorMemberships(userId, role)` → `ActorMemberships` (org/facility
  memberships, admin sets, primary facility) — loaded once per request.
- `resolveFacilityForStaff({ userId, role, requestedFacilityId })` → the effective,
  membership-validated, lifecycle-checked facility.
- `canAccessFacility(m, facilityId, orgId)` — the accessibility predicate.
- `assertOrganizationAccess` / `assertOrganizationAdmin` / `assertFacilityAdmin` —
  used by the enterprise services.
- `requireActorMemberships(permission)` — the enterprise route helper: coarse RBAC
  gate + membership load in one call.

## Error shaping (anti-enumeration)

| Situation | Result |
| --- | --- |
| Facility/org the caller has no standing in | `NotFoundError` → **404** ("Not found.") |
| Caller is a member but the tenant is SUSPENDED/DEACTIVATED | `TenantAccessError` → **403** |
| Caller is a member but not an administrator | `TenantAccessError` → **403** |
| Missing RBAC permission | `ForbiddenError` → **403** |

`TenantAccessError` is a plain 4xx error carrying its own `status`, mapped by the
existing `withApiErrors`. Its messages are safe to surface because they are only
raised once membership is already established — they never reveal another tenant's
existence.

## What client input can and cannot do

A client may supply `requestedFacilityId` (query/body). The server treats it as a
*request*, validates it against persisted membership, and either honours it or
refuses 404-shaped. A manipulated `{ organizationId: "other-org" }` or
`{ facilityId: "other-facility" }` never bypasses this, because tenant scope is
re-derived server-side and enterprise services derive the organization from the
*resource* (e.g. the facility's `organizationId`), not from any caller-supplied
field.

## Break-glass and tenant boundaries

Break-glass is a C4 mechanism that can relax a *care-relationship* requirement for
a patient within a facility. It never reaches the tenant layer, so a break-glass
window in Facility A cannot make Facility B or Organization B resolvable. Tenant
boundaries are absolute.
