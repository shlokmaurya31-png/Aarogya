# Command Center — Security & Privacy (D10)

D10 inherits the full platform security model and adds nothing that can bypass it. C4
remains authoritative; the Command Center grants nothing and mutates nothing.

## Tenant isolation
- Facility/organization scope is resolved server-side by D1 `requireFacilityStaff`
  (the chokepoint). Client-supplied `facilityId`/`organizationId`/`departmentId` are
  never authoritative — a caller can only reach a facility they have standing in;
  cross-facility/cross-org requests fail 404-shaped (proven by the D1 gate and the D10
  facility-isolation test: facility A's metrics never include facility B's data).
- Every metric query is filtered by the resolved `facilityId`.

## Authorization (per-section)
- Base gate: `hospital:command-center:view`.
- Financial sections (Revenue, Claims) additionally require `billing:view`.
- Incidents requires `quality:incident:read`.
- A caller lacking a section's permission sees it in `restrictedSections` — never as an
  error and never as fabricated zeros (verified: NURSE → revenue/claims restricted).

## Privacy (minimum necessary)
- Command Center views are AGGREGATE by default. Critical-results and incidents expose
  counts/ages only — never patient identity, diagnosis, medications, notes, or result
  values in the overview.
- Drill-downs are privacy-aware: patient identity is included only for clinically
  authorized viewers (`clinical:chart:read`/`encounter:read`); otherwise omitted.
- Financial drill-downs (open-invoices, claims-denied) require `billing:view` (verified:
  NURSE denied).

## Input safety / IDOR
- Drill-downs are a CLOSED allow-list (`DRILLDOWN_KINDS`) — there is no general-purpose
  data API; an arbitrary kind is rejected (verified).
- All queries are parameterized via Prisma (no string SQL) — SQL injection and
  prototype pollution are structurally prevented.
- Time windows are bounded: custom ranges are capped (≤400 days) and require from<to;
  oversized/inverted ranges are rejected (verified). Drill-downs are paginated (≤50).
- Metric/section keys are validated against a closed set; unknown keys are 400.

## Audit
Aggregate metric reads are not audited (they are hot-path reads). Sensitive actions
(privileged drill-downs, workflow mutations, configuration changes, exports) reuse the
existing AuditEvent system — D10 adds no second audit system.
