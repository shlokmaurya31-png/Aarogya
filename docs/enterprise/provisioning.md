# Provisioning (Phase D1)

## Workflow

`provisionOrganization` (`src/lib/enterprise/provisioning.ts`) creates a whole
tenant structure atomically:

```
CREATE ORGANIZATION (by slug)
  → CREATE FACILITY (by org+slug, status PROVISIONING)
    → CREATE ADMIN MEMBERSHIPS (org admin + facility admin for the named user)
      → CREATE DEPARTMENTS
        → ACTIVATE facility
```

The whole sequence runs inside a single `prisma.$transaction`, so a failure never
leaves a half-provisioned tenant. It is **platform-only**
(`enterprise:platform:manage`), and emits `enterprise.provisioning.started`,
`.completed`, and `.failed` audit events.

## Idempotency

Every step is an `upsert` keyed on a natural identity (organization slug, facility
`(org, slug)`, membership `(user, scope)`, department `(facility, name)`), so a
retried request with the same slugs **reuses** existing rows rather than
duplicating them. The concurrency gate proves that even six *simultaneous*
provisioning calls for the same slug converge to exactly one organization, one
facility, and one administrator.

## API

`POST /api/hospital/enterprise/provisioning`

```json
{
  "organization": { "name": "...", "slug": "acme-health", "legalName": "..." },
  "facility":     { "name": "...", "slug": "acme-central", "city": "..." },
  "adminUserId":  "<user id who becomes org + facility admin>",
  "departments":  ["Emergency", "Cardiology"]
}
```

Slugs are validated (`^[a-z0-9-]+$`). The `adminUserId` must be an existing user.

## Related lifecycle APIs

- `POST /api/hospital/enterprise/organizations` — create an organization (platform).
- `POST /api/hospital/enterprise/organizations/{id}/facilities` — create a facility
  (org admin); starts PROVISIONING.
- `POST /api/hospital/enterprise/facilities/{id}/transition` — activate/suspend/…
- `POST /api/hospital/enterprise/organizations/{id}/transition` — org lifecycle.
