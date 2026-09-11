# Phase B — Final Integration & Production Integrity Gate

Closes Phase B (B1–B10). This was not a feature phase: it was a system-wide
integration, security, concurrency and migration gate run against everything
built through Phase B10, following the same convention as
`PHASE_4_5_INTEGRITY_GATE.md` and `PHASE_5_5_INTEGRITY_GATE.md`.

The governing assumption was that **passing per-module tests does not mean the
system is correct**, and the objective was to break the seams between modules
before production does.

## 1. What made this gate different

Every prior phase verified its own module. This gate was the first run against a
**real PostgreSQL 16 instance** rather than the SQLite development database.
That single change surfaced two defects that SQLite is structurally incapable of
revealing:

- SQLite does not validate a foreign-key target at `CREATE TABLE` time, so a
  forward reference in the B10 migration was invisible locally and fatal in
  production.
- SQLite serializes writers, so no lock-ordering problem can ever deadlock
  there. PostgreSQL deadlocked immediately.

## 2. Findings and fixes

| Severity | Finding | Root cause | Fix |
| --- | --- | --- | --- |
| **P0** | The B10 PostgreSQL migration aborts; the migration history cannot be replayed from zero, so Phase B10 could not be deployed to production at all. | `QualityFinding` declared an inline `REFERENCES "QualityAudit"` 22 lines before `QualityAudit` was created. SQLite tolerates forward FK references; PostgreSQL rejects them (`42P01`). | Reordered `CREATE TABLE "QualityAudit"` ahead of `QualityFinding`. The migration had never applied to any database, so editing it in place carries no historical-integrity risk. A repo-wide scan confirmed this was the only forward reference across all 19 PostgreSQL migrations. |
| **P0** | Mass assignment in `updateRca`: a client could move an RCA to another facility, forge a review attestation, rewrite authorship, or re-point the incident link. Reachable by any `DOCTOR` (holds `quality:rca:create`). | The route passed `body.patch` (arbitrary JSON) straight through, and the service spread it into `updateMany`'s `data`. The TypeScript `Partial<{…}>` gave no runtime protection. | Replaced the spread with an explicit editable-field allow-list. Review remains exclusively `reviewRca()`'s job. Added the missing audit event for RCA edits. |
| **P1** | Cross-facility write via quality parent references (evidence IDOR). A reporter in facility A could attach evidence to, or hang a CAPA/finding off, facility B's records by guessing an id. | `attachEvidence` validated only `documentId`; `createFinding` validated only `auditId`; `createCapa` validated only `incidentId`. The remaining parent links were persisted unchecked. | Added `assertQualityRefsInFacility()` covering all eight reference types and applied it in `createQualityIncident`, `createCapa`, `createFinding` and `attachEvidence`. Unknown ids report not-found so the endpoint never confirms a protected record exists elsewhere. |
| **P1** | Self-credentialing. A staff member could record their own credential and mark it `VERIFIED`, satisfying every `requireCredential()` gate without independent review. | `verifyCredential` applied no maker/checker guard, despite the B10 permission model separating `credential:verify` from plain management precisely to create one. | Verifier must now be an active member of the facility, and may be neither the credential's owner nor the person who recorded it — matching the existing `approvePurchaseOrder`/`approveRequisition` same-actor convention. |
| **P1** | Self-granting of clinical privileges. | `grantPrivilege` never compared `staffId` against `grantedByStaffId`. | Self-grant refused; `grantedByStaffId` validated in-facility; `documentId` validated (as `createCredential` already did). |
| **P1** | Missing maker/checker on quality sign-off: an RCA author could review their own analysis, and a CAPA owner/creator could verify their own action — making both attestations meaningless. | Only facility membership was checked. | Same-actor guards added to `reviewRca` and the CAPA `VERIFIED` transition. |
| **P1** | Overlapping roster shifts could both commit under concurrency. | The overlap guard was a `findFirst` followed by a `create` — not atomic under READ COMMITTED. The `@@unique([staffId, startAt])` index only catches *identical* start instants, not genuine overlap. | Added the `staff_shift_no_overlap` GiST `EXCLUDE` constraint, the same race-proof mechanism B3 uses for theatres and B1 for imaging resources. |
| **P1** | Concurrent RFQ award deadlocked in PostgreSQL (`40P01`), and the losing transaction surfaced to the client as an opaque **500**. | `selectQuotation` locked its own quotation row first and then reached for the rival bids in the losing-bid sweep, so two concurrent awards formed a circular wait. | The award now takes a lock on the parent `Rfq` row first, so both transactions contend on the same row in the same order. The loser blocks and then fails cleanly on the guarded update. |
| **P1** | Any lost database race anywhere in the system was reported as a masked 500. | `withApiErrors` had no concept of a retryable concurrency failure. | Added `ConflictError` (409) and structural detection of `40P01` / `40001` / Prisma `P2034` / SQLite `database is locked`, mapped to a retryable 409 with a fixed message that leaks no database internals. |
| **P2** | Suspended, inactive or departed staff could be named as investigator, RCA reviewer, auditor, CAPA owner or measure reviewer. | `assertQualityStaffInFacility` documented an ACTIVE check in its comment but never performed one. | Status is now enforced, and the helper is applied to the transition/reopen actor and measure reviewer, which previously wrote unvalidated staff ids into the audit trail. |
| **P2** | A renewed credential or privilege was rejected whenever an expired predecessor row sorted first. | `requirePrivilege`/`requireCredential` selected the first `ACTIVE`/`VERIFIED` row and only then tested expiry, disagreeing with `hasActivePrivilege`/`hasActiveCredential`, which use a combined predicate. | Both now select on status **and** non-expiry. Fail-closed ordering preserved. |
| **P2** | Unrelated failures (FK violation, dropped connection, genuine bug) were reported to users as "already exists" and never reached the 500 path or the server log. | Four blanket `.catch(() => { throw new BadRequestError(…) })` handlers in the quality service. | Introduced `asDuplicateError()`, which translates only `P2002`/unique violations and rethrows everything else. |
| **P3** | Permanent schema drift: `Bed_icuUnitId_idx` existed in PostgreSQL but in neither `schema.prisma` nor the SQLite tree, so `migrate diff` never came back clean and the next `migrate dev` would have emitted a `DROP INDEX`. | The B1 ICU PostgreSQL baseline created an index the schema never declared. | Declared `@@index([icuUnitId])` on `Bed` and added the index to the SQLite tree. Both engines now diff clean. |
| **P3** | Two audit event types were written as raw strings without being declared in `AuditEventType`, so the catalog was incomplete for downstream consumers. | `tx.auditEvent.create()` inside a transaction takes a plain string and bypasses the typed helper. | Declared `hospital.appointment.confirmed` and `hospital.quality.rcaUpdated`. |

## 3. Verified as already correct

These were attacked and held; they are recorded so a future phase does not
re-litigate them:

- **Tenant boundary.** `requireFacilityStaff()` derives `facilityId` from the
  caller's `HospitalStaffProfile` row, never from the request. All 326 hospital
  API routes are permission-guarded, and none performs an id lookup without a
  facility reference.
- **Sessions.** HMAC-SHA256 signed, `httpOnly`, compared with `timingSafeEqual`,
  expiry enforced, and `requireSession()` re-derives the role from the database
  rather than trusting the cookie payload. Facility is never carried in the
  session at all.
- **Legacy `/hospital`.** Redirects to `/hospital-os/login`. The canonical
  Hospital OS has **zero** imports of the prototype Zustand/localStorage stores;
  those belong to the separate Scholar surface and were left untouched.
- **Command Centers.** Every dashboard metric is a live, facility-scoped Prisma
  aggregate issued in parallel. No mock data, no hardcoded counts.
- **Secrets and seeding.** No `.env` is committed, no credentials are hardcoded
  in `src/`, and `prisma/seed.ts` refuses to run under `NODE_ENV=production`
  without an explicit `ALLOW_DATABASE_SEED=true`.
- **Two audit mechanisms are intentional.** `recordAuditEvent()` (typed, global
  client) cannot join a transaction; inside `$transaction` the `tx` form is
  required so the audit row rolls back with its mutation. A third pattern was
  deliberately not introduced.

## 4. SQLite vs PostgreSQL (gate §33)

`staff_shift_no_overlap` joins `imaging_resource_no_overlap`,
`surgery_schedule_no_overlap` and `tariff_no_overlap` as a PostgreSQL-only
guarantee. SQLite has neither GiST nor `EXCLUDE`.

These safeguards are **deliberately not removed** to make the two engines behave
identically. SQLite serializes writers, so the in-service transactional check is
adequate there; PostgreSQL permits genuine write concurrency and therefore needs
the database-level guarantee. The difference is covered by
`scripts/verify-postgres-phase-b-final.ts`.

## 5. Deferred, not defective (gate §53)

**The B10 workforce module has no HTTP surface.** `src/lib/hospital/workforce/`
(service, command centre, credential-aware authorization) is complete, now
tested, and exercised by the verification script, but no route imports it, and
`enforcePrivilegeForContext()` is not yet wired into any clinical route.

In practice this means the 14 `workforce:*`, `credential:*` and `privilege:*`
permissions are granted but not yet reachable over HTTP, and credential-aware
authorization is a **foundation that is not yet enforced on any clinical
operation**.

This is recorded as deferred scope rather than fixed here for two reasons.
Wiring `requirePrivilege()` into live clinical routes with no privilege rows
seeded would deny every existing clinical workflow, and adding a full workforce
API surface would be new feature work, which this gate explicitly excludes. The
correct next step is a dedicated phase that seeds privilege data, exposes the
workforce API, and enables enforcement route by route.

The internal defects in that module (self-verification, self-granting, the
expiry-selection bug) **were** fixed, so the foundation is sound when it is
eventually wired.

## 6. Remaining risks

- Credential-aware authorization is not enforced on clinical operations (§5
  above). Until it is wired, RBAC alone gates those workflows — which is the
  pre-B10 behaviour, not a regression.
- Three pre-existing ESLint errors remain in Scholar UI components
  (`TopBar.tsx` and one other): `setState` inside an effect, and an impure call
  during render. They are outside the Hospital OS surface and untouched by this
  gate; they were present before it and are unchanged by it.
- Deployment was not verified end to end from this environment; see the gate
  report's deployment section.

## 7. Reproducing the gate

```bash
# 1. Disposable PostgreSQL 16
docker run -d --name aarogya-gate-pg \
  -e POSTGRES_PASSWORD=gate -e POSTGRES_USER=gate -e POSTGRES_DB=aarogya_gate \
  -p 55433:5432 postgres:16

# 2. PostgreSQL-flavoured schema + the production migration tree
mkdir -p .pgreplay
sed 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma > .pgreplay/schema.prisma
cp -r prisma/migrations-postgres-baseline .pgreplay/migrations

export DATABASE_URL="postgresql://gate:gate@localhost:55433/aarogya_gate"

# 3. Replay the whole history from zero, then prove there is no drift
npx prisma migrate deploy --schema .pgreplay/schema.prisma
npx prisma migrate diff --from-url "$DATABASE_URL" \
  --to-schema-datamodel .pgreplay/schema.prisma --exit-code --script

# 4. Seed and run the gate
npx prisma generate --schema .pgreplay/schema.prisma
npx tsx prisma/seed.ts
npx tsx scripts/verify-postgres-phase-b-final.ts
for s in scripts/verify-postgres-*.ts; do npx tsx "$s"; done

# 5. Restore the SQLite client for local development
npx prisma generate
```

`.pgreplay/` is a scratch directory and is git-ignored.

**The verification scripts are not idempotent.** They consume appointment slots,
roster windows and document versions, so re-running them against an
already-exercised database produces spurious failures — during this gate, a
second pass on the same database reported 8 such false failures (appointment
slot exhaustion and an extra nursing assessment version) that all cleared on a
freshly seeded database. Always drop, re-migrate and re-seed between full runs.
