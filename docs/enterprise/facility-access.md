# Facility access & membership (Phase D1)

## Who can reach which facility

A non-platform identity may act in a facility when **any** of these holds:

1. it is their **clinical home facility** (`HospitalStaffProfile.facilityId`) —
   always implicitly accessible; the membership layer only *adds* facilities, it
   never removes the one the staff profile establishes;
2. they have an **ACTIVE `FacilityMembership`** for it (explicit multi-facility grant);
3. they are an **organization administrator** of that facility's org (reaches
   every facility under the org);
4. they are the **platform administrator** (`AAROGYA_ADMIN`).

A SUSPENDED membership grants nothing. This set is computed once by
`loadActorMemberships` and evaluated by `canAccessFacility`
(`src/lib/auth/tenantContext.ts`).

## Multi-facility is explicit

A staff member with one facility behaves exactly as before D1. A caller who is an
explicit member of several facilities may act in any of them by passing
`requestedFacilityId` — and **only** those. Requesting a facility with no standing
is refused **404-shaped** (indistinguishable from "does not exist").

## The chokepoints — no route churn

The two pre-existing server chokepoints were *extended*, so the whole Hospital OS
became organization-aware without touching ~337 routes:

- **`requireFacilityStaff(permission, requestedFacilityId?)`** — used by ~337
  routes. Resolves the facility via `resolveFacilityForStaff` (membership +
  lifecycle), returns `organizationId`, `facilityAdmin`, `orgAdmin`. Preserves the
  classic contracts: a non-staff caller with no requested facility is 401; a
  suspended staff profile is 403.
- **`buildAuthorizationActor(requestedFacilityId?)`** — the C4 engine's actor
  builder. Now carries `organizationId` and gates the effective tenant's lifecycle.

## Effective-facility resolution (`resolveFacilityForStaff`)

```
platform admin      → must name a facility; existence checked, membership not
                      required, lifecycle not enforced (recovery)
otherwise           → target = requestedFacilityId ?? primaryFacilityId
                      not accessible          → 404 (NotFoundError)
                      org/facility not ACTIVE → 403 (TenantAccessError)
                      else                    → { facilityId, organizationId,
                                                  facilityAdmin, orgAdmin }
```

## Administration levels

Represented as **(RBAC permission) + (membership admin flag)** — never a new
`Role`:

| Level | Who | Reach |
| --- | --- | --- |
| Platform admin | `AAROGYA_ADMIN` | All tenants (platform operation/recovery); still subject to every C4 clinical check |
| Organization admin | `OrganizationMembership.isAdmin` | Their org + every facility under it |
| Facility admin | `FacilityMembership.isAdmin` (the HOSPITAL_ADMIN scope) | That facility only; **not** the parent org |
| Standard user | membership without `isAdmin` | Operate within authorized scope |

The RBAC permission (`enterprise:*`) is the coarse gate; the membership admin flag
is the fine, tenant-scoped gate. A plain facility admin holds
`enterprise:organization:manage` yet is still refused organization administration
by `assertOrganizationAdmin` — deny by default.
