# Phase 4 Diagnostics — Production Readiness Checklist

Companion to `docs/PHASE_4_DIAGNOSTICS_ARCHITECTURE.md` §12. Produced at
the end of Phase 4 Milestone E (Diagnostics Hardening). Scope: the
Diagnostics OS surface (Order integration, Laboratory, Radiology,
Unification) built across Milestones A-D and hardened in Milestone E — not
a whole-platform audit.

Status legend: **COMPLETE** · **PARTIAL** · **NOT IMPLEMENTED** ·
**REQUIRES INFRASTRUCTURE** · **FUTURE**

Nothing below is marked COMPLETE unless it was verified live this
milestone (not assumed from a prior report) or verified in code with a
concrete test.

## Application

| Item | Status | Notes |
|---|---|---|
| Lab full lifecycle (order→collect→receive→accept→result→verify→acknowledge→amend) | COMPLETE | Re-verified live end-to-end this milestone, including the amendment re-critical-alert path. |
| Radiology full lifecycle (order→schedule→checkin→start→complete→report→verify→acknowledge→amend) | COMPLETE | Same, live. |
| Unified Diagnostics workspace (`/hospital-os/diagnostics`) | COMPLETE | Filters, critical banner, cross-domain search all re-verified live. |
| State-machine transition gaps (specimen reject, study cancel) | COMPLETE | Fixed this milestone (§12.1 of the architecture doc). |
| Multi-specimen-per-order / multi-study-per-order | NOT IMPLEMENTED | Schema-ready (non-unique FKs), no workflow built — unchanged scope decision from Milestone B/C. |
| Panel-ordering UI | NOT IMPLEMENTED | Data model supports it; only direct-API panel orders exercised. |
| Catalog/resource management UI | NOT IMPLEMENTED | Permissions (`lab:catalog:manage` etc.) declared and granted to HOSPITAL_ADMIN, no routes exist yet. |

## Database

| Item | Status | Notes |
|---|---|---|
| One-current-row-per-order invariant (LabResult, ImagingReport) | COMPLETE | DB-level partial unique indexes added this milestone, not just app checks. |
| One-active-study-per-order invariant | COMPLETE | Same. |
| Duplicate-billing prevention at the DB layer | COMPLETE | `Charge(sourceType, sourceId)` unique constraint added this milestone. |
| Duplicate-recollection prevention at the DB layer | COMPLETE | `Specimen.recollectionOfSpecimenId` unique constraint added this milestone. |
| Composite indexes for facility-scoped hot paths | COMPLETE | `Specimen(facilityId,status)`, `ImagingStudy(facilityId,status)`, `LabResult`/`ImagingReport(isCritical,acknowledgedAt,isCurrent)`, `Task(facilityId,status)` added this milestone. |
| Version-chain cycle/immutability enforcement (`previousVersionId`) | PARTIAL | `@unique` prevents fan-in (two newer rows pointing at one older row); no DB-level cycle detection or post-creation immutability guarantee — application code never mutates it after create, but nothing at the schema level stops a future bug from doing so. |
| Postgres migration | REQUIRES INFRASTRUCTURE | Datasource is SQLite; schema has a commented provider line for Postgres. All Milestone E DB fixes (partial indexes, unique constraints) use Postgres-compatible syntax verified by inspection, not yet tested against a real Postgres instance. |
| Resource double-booking DB-level constraint | FUTURE | Documented limitation (architecture doc §12.4/§12.5) — app-level count-then-create today, needs `SELECT ... FOR UPDATE` or a partial unique index before production Postgres concurrency. |

## Security

| Item | Status | Notes |
|---|---|---|
| No secrets committed to the repository (current or historical) | COMPLETE | Verified via `git ls-files`/`git log --all --full-history` this milestone. |
| Server-side input validation on diagnostic mutation routes | COMPLETE | Added this milestone: priority/resultType whitelists, date/numeric bounds, string length caps. |
| Error responses never leak stack traces / Prisma internals | COMPLETE | Verified live; `withApiErrors`'s generic-500 fallback confirmed sanitized. |
| `isCritical` boolean-coercion footgun | COMPLETE | Fixed this milestone. |
| TLS termination, security headers (CSP/HSTS/etc.) | REQUIRES INFRASTRUCTURE | Not an application-code concern this milestone could address; not fabricated as done. |
| Rate limiting / WAF | REQUIRES INFRASTRUCTURE | Same. |
| Production session-cookie flags under real HTTPS origin | REQUIRES INFRASTRUCTURE | Needs a real deployment environment to verify, not local dev. |
| Demo-account seeding gated against accidental production use | FUTURE | Seed passwords are synthetic and hashed, but nothing currently stops `prisma db seed` from being run against a production `DATABASE_URL`. |

## RBAC

| Item | Status | Notes |
|---|---|---|
| Full role × diagnostic-action permission matrix built and verified against actual route checks | COMPLETE | This milestone; see architecture doc §12.9. |
| `clinical:chart:read` narrower permission (replacing over-granted `patient:read` on clinical routes) | COMPLETE | Added this milestone; FRONT_DESK/BILLING_STAFF now correctly excluded, verified live. |
| Cross-tenant `resourceId` IDOR on imaging reschedule | COMPLETE | Fixed this milestone, verified live with a temporary cross-facility fixture. |
| Direct-ID access re-tested across every diagnostic entity type (order/specimen/result/study/report/resource) | COMPLETE | Live this milestone and in Milestone D. |

## Tenancy (facility isolation)

| Item | Status | Notes |
|---|---|---|
| Every diagnostic route facility-scoped in its `where` clause | COMPLETE | Re-audited this milestone; `alertEngine.ts`'s 3 unscoped queries (relying on post-fetch filtering) fixed. |
| Concurrent cross-facility request isolation | COMPLETE | Verified live under genuine parallel load, zero item overlap. |
| Aggregate/list endpoints (Command Center, Doctor Dashboard, unified worklist) facility-scoped | COMPLETE | Re-verified this milestone. |

## Clinical safety

| Item | Status | Notes |
|---|---|---|
| Verified/amended records cannot be silently overwritten | COMPLETE | Verified adversarially this milestone (intended API, malformed request, repeated request). |
| Critical result/finding survives amendment (re-alerts, doesn't vanish) | COMPLETE | Verified live. |
| Critical acknowledgement correctly attributed and scoped | COMPLETE | Fixed and verified this milestone (was previously an arbitrary `results[0]` pick with no `isCritical` check). |
| Wrong-patient order/result linkage | COMPLETE | CRITICAL finding, fixed this milestone (`patientId`/`encounter.patientId` cross-check). |
| Fail-closed behavior on cross-facility/unauthorized attempts | COMPLETE | Consistently a clean 403/404, never a silent misattribution or partial success. |

## Audit

| Item | Status | Notes |
|---|---|---|
| Every clinically meaningful mutation has an audit event | COMPLETE | Two gaps (task creation, auto-charge creation) fixed this milestone; everything else re-verified already correct. |
| Audit events timed strictly after transaction commit | COMPLETE | Re-verified this milestone across every route. |
| `AuditEvent` queryable by `facilityId`/`patientId` directly (not via `detail` JSON) | NOT IMPLEMENTED | Codebase-wide schema gap (every phase), out of this milestone's diagnostics-scoped fix budget. |

## Billing

| Item | Status | Notes |
|---|---|---|
| Exactly-once charge per order, including under concurrent duplicate submission | COMPLETE | CRITICAL finding, fixed and verified live this milestone (root cause: order-creation dedupe; defense-in-depth: DB unique constraint). |
| Exactly-once charge per amendment (no re-charge on amend) | COMPLETE | Verified — amendment never calls the charge hook. |
| Charge correctly attributed to encounter/facility/patient/order/amount | COMPLETE | Re-verified this milestone. |

## Concurrency

| Item | Status | Notes |
|---|---|---|
| Duplicate order submission race | COMPLETE | Fixed and verified live (exactly 1 order/specimen/charge/task survives). |
| Duplicate result/report entry race | COMPLETE | Fixed and verified live (DB-level constraint, clean 4xx for the loser). |
| Duplicate study scheduling race | COMPLETE | Same. |
| Duplicate recollection race | COMPLETE | Same. |
| Critical-acknowledgement race | COMPLETE | Now a guarded CAS; verified two concurrent acks resolve to one consistent winner. |
| Resource double-booking race (different orders, same resource+time) | PARTIAL | SQLite-safe today (transaction serialization); documented Postgres gap, see Database section. |

## Observability

| Item | Status | Notes |
|---|---|---|
| Structured application logging | NOT IMPLEMENTED | No dedicated logging infrastructure exists beyond `console.error` in `withApiErrors`'s catch-all and Next.js dev server output. |
| Metrics/tracing | NOT IMPLEMENTED | Not built this milestone or any prior one — explicitly out of scope per the brief's hard rules (no new observability infrastructure). |
| Error tracking (Sentry-style) | NOT IMPLEMENTED | Same. |

## Backups

| Item | Status | Notes |
|---|---|---|
| Automated database backups | NOT IMPLEMENTED | Local SQLite dev database; no backup strategy exists or was in scope this milestone. |
| Point-in-time recovery | NOT IMPLEMENTED | Requires the Postgres migration first. |

## Disaster recovery

| Item | Status | Notes |
|---|---|---|
| DR runbook | NOT IMPLEMENTED | Not addressed — out of scope for an application-hardening milestone. |
| Multi-region/failover | NOT IMPLEMENTED | Same. |

## Secrets

| Item | Status | Notes |
|---|---|---|
| No secrets in tracked files or git history | COMPLETE | Verified this milestone. |
| `.env`/`.env.local` gitignored | COMPLETE | Verified. |
| Secret rotation tooling | NOT IMPLEMENTED | No secrets manager integration exists; `AUTH_SECRET`/`ADMIN_PASSWORD` etc. are plain environment variables. |
| Demo-credential production guard | FUTURE | See Security section. |

## PostgreSQL migration

| Item | Status | Notes |
|---|---|---|
| Schema Postgres-compatibility | PARTIAL | Standard Prisma DSL portions are provider-agnostic by construction; the 3 hand-authored partial-unique-index migrations use syntax verified compatible with Postgres by inspection, not yet tested against a live Postgres instance. |
| Concurrency behavior under Postgres `READ COMMITTED` | PARTIAL | The duplicate-row races (§ Database) are now DB-constraint-backed and Postgres-safe by construction. The resource-scheduling double-booking race is NOT yet Postgres-safe — documented, not fixed. |
| Migration execution against Postgres | NOT IMPLEMENTED | Never run; `prisma migrate deploy` against a real Postgres target is untested. |

## External integrations

| Item | Status | Notes |
|---|---|---|
| PACS / DICOM | NOT IMPLEMENTED | Explicitly out of scope (hard rule, every milestone). |
| HL7 / FHIR | NOT IMPLEMENTED | Same. |
| ABDM | NOT IMPLEMENTED | Same. |
| External analyzer/modality integration | NOT IMPLEMENTED | Same. |
| AI clinical interpretation | NOT IMPLEMENTED | Same — explicitly forbidden by every milestone's hard rules. |

---

## Do not deploy to a real hospital until

1. The Postgres migration is actually executed and tested (not just judged compatible by inspection) — see PostgreSQL migration section.
2. The resource double-booking race is given a real DB-level guard (`SELECT ... FOR UPDATE` or a partial unique index) before relying on it under production concurrency.
3. TLS, security headers, and rate limiting are added at the infrastructure layer — none of this is application code this milestone could provide.
4. A demo-credential production guard is added so `prisma db seed` cannot silently create well-known-password admin accounts against a real database.
5. Backups, DR, and basic observability (structured logging at minimum) exist — currently none do.
6. `AuditEvent` gains facility/patient-scoped querying if compliance/investigation requirements demand it (currently requires a join through `detail`).

Everything else audited this milestone — application-layer security, RBAC,
tenancy, clinical-safety invariants, concurrency on the diagnostics
duplicate-row/billing paths, input validation, and error handling — is
COMPLETE and verified live, not assumed.
