# Organization & facility model (Phase D1)

## Organization

```prisma
model Organization {
  id            String             @id @default(cuid())
  slug          String?            @unique   // stable human id; nullable only for backfill
  name          String
  legalName     String?
  status        OrganizationStatus @default(ACTIVE)
  createdAt     DateTime
  updatedAt     DateTime
  suspendedAt   DateTime?
  deactivatedAt DateTime?
  facilities    Facility[]
  memberships   OrganizationMembership[]
  configValues  OrgConfigValue[]
  auditEvents   AuditEvent[]
}
enum OrganizationStatus { ACTIVE  SUSPENDED  DEACTIVATED }
```

Before D1 this model was `{ id, name, createdAt, facilities }`. D1 added the
lifecycle, slug, legal identity, and back-relations. No licensing/billing fields.

## Facility

```prisma
model Facility {
  id             String   @id @default(cuid())
  name           String
  city           String?
  slug           String?                       // unique per organization
  organizationId String                        // a facility belongs to exactly one org
  status         FacilityStatus @default(ACTIVE)
  createdAt / updatedAt / suspendedAt / deactivatedAt
  memberships    FacilityMembership[]
  configValues   FacilityConfigValue[]
  // ...all pre-existing clinical relations, unchanged...
}
enum FacilityStatus { PROVISIONING  ACTIVE  SUSPENDED  DEACTIVATED }
@@unique([organizationId, slug])
```

The `Facility → Organization` relation pre-existed D1; the clinical relations
(departments, wards, beds, patients, encounters, …) are untouched.

## Lifecycle transitions

Declared as an explicit allow-list in `src/lib/enterprise/constants.ts`; a
transition not listed is refused.

**Organization:** `ACTIVE↔SUSPENDED`, `ACTIVE→DEACTIVATED`, `SUSPENDED→DEACTIVATED`,
and `DEACTIVATED→ACTIVE` (**platform-only** — recovery, never casual).

**Facility:** `PROVISIONING→ACTIVE`, `PROVISIONING→DEACTIVATED`,
`ACTIVE↔SUSPENDED`, `ACTIVE→DEACTIVATED`, `SUSPENDED→DEACTIVATED`,
`DEACTIVATED→ACTIVE` (**platform-only**). Nothing transitions *into* PROVISIONING —
it is only a start state, so a new facility must be explicitly activated.

Suspension/deactivation set `suspendedAt`/`deactivatedAt` and **never delete
clinical or financial data**. A non-ACTIVE tenant refuses normal operation at the
tenant-context boundary (see [tenant-authorization](tenant-authorization.md));
administrative recovery by an authorized operator remains possible.

## Membership

```prisma
model OrganizationMembership { id, userId, organizationId, isAdmin, status, createdByUserId, ... @@unique([userId, organizationId]) }
model FacilityMembership     { id, userId, facilityId,     isAdmin, status, createdByUserId, ... @@unique([userId, facilityId]) }
enum MembershipStatus { ACTIVE  SUSPENDED }
```

Membership is modelled at the **User (identity)** level, not the staff-profile
level, because a platform or organization administrator legitimately has no
clinical staff profile. `isAdmin` is scope-local: a facility admin is not an org
admin, and neither is a platform admin. The unique constraints are what make
duplicate-membership races produce one row, not two.

`AuditEvent` also gained a nullable `organizationId` so organization-scoped
events (which often have no facility) can be queried without a second table.
