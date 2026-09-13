# Multi-tenancy (Phase D1)

Aarogya is a multi-tenant enterprise healthcare platform. This document describes
the tenant model D1 established; the details of each layer live in the sibling
documents linked below.

## The hierarchy

```
AAROGYA PLATFORM
└── ORGANIZATION            (the enterprise/customer tenant — lifecycle, config)
    └── FACILITY            (a hospital/clinic — lifecycle, config, clinical data)
        └── DEPARTMENT       (config)
            └── WARD / UNIT
                └── BED
```

`Organization` and `Facility` already existed before D1 (a `Facility` has always
belonged to exactly one `Organization`). D1 added the lifecycle, the explicit
membership layer, hierarchical configuration, and the tenant-context resolver
that turns "a facility is owned by an org" into an enforced access boundary.

## The one rule everything else serves

> A user may only access what their organization, facility, role, credentials,
> purpose, and existing authorization policy allow — and the server derives the
> effective organization/facility from authenticated identity and persisted
> membership, never from a client-supplied identifier.

Concretely:

- No cross-organization access by default.
- No cross-facility access by default.
- A client may *request* a facility; the server decides whether the caller may
  enter it. A requested facility the caller has no standing in is refused as
  **404-shaped**, so ids cannot be used to enumerate other tenants.

## The two authorization layers, kept separate

| Layer | Question | Where |
| --- | --- | --- |
| **Tenant scope** | Which organization / facility may this identity act in at all? | `src/lib/auth/tenantContext.ts` |
| **Clinical authorization (C4)** | May this actor perform this action on this patient/resource? | `src/lib/auth/authorize/*` |

Neither substitutes for the other. Organization membership is **not** patient
consent; facility membership is **not** a clinical purpose. Break-glass lives
entirely in the C4 layer and can relax a care-relationship requirement — it can
**never** move an actor across a tenant boundary, because it never reaches the
tenant layer.

## What D1 did NOT do (deferred to D2+)

Subscription/licensing/metering, enterprise analytics/reporting, API marketplace,
workflow builder, mobile redesign, new clinical modules. No such fields or tables
exist yet.

See also: [organization-model](organization-model.md) ·
[facility-access](facility-access.md) · [tenant-authorization](tenant-authorization.md) ·
[configuration-inheritance](configuration-inheritance.md) ·
[provisioning](provisioning.md) · [d1-security-model](d1-security-model.md) ·
[d1-readiness](d1-readiness.md).
