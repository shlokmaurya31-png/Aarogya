# Phase 6.6 — Core Integrity P0 Remediation

Pure remediation gate. No new modules, no redesign, no ICU/OT/Blood Bank work. Fixes the three P0 correctness/safety defects and resolves the Inventory/Diagnostics live-render discrepancy identified by the Phase 6.5 audit (`docs/POST_PHASE_6_ROADMAP.md`).

## 1. Scope

In scope: `MedicationItemLink` write path (P0-A), invoice payment-allocation over-allocation race (P0-B), medication administration double-recording race (P0-C), Inventory/Diagnostics nav render discrepancy (P0-D). Nothing else was touched. Explicitly out of scope and not built: ICU, OT, Blood Bank, Nursing charting, ADT taxonomy, Procurement Officer role, event-bus/microservices/Kubernetes/AI — all deferred per the brief.

## 2. Baseline

Starting commit `711f4ab` (branch `main`, in sync with `origin/main`, clean tree). `tsc --noEmit`: 0 errors. `vitest run`: 270/270 passing, 35 files. `next build`: succeeds. `eslint`: 3 pre-existing errors / 18 warnings, all in unrelated legacy files (`AiAssistantPanel.tsx`, `TopBar.tsx`, `<img>` notices) — unchanged throughout this phase. This exactly matched the Phase 6.5 audit's own recorded baseline, confirming no drift between the audit and the start of this remediation.

## 3. P0 findings (independently reproduced, not trusted from the audit doc)

Four parallel research passes reproduced every finding against the actual code before any fix was designed:

- **P0-A**: `MedicationItemLink` had exactly one call site anywhere — 4 hardcoded rows in `prisma/seedData/hospitalPhase6a.ts` — and zero API/UI path. Even the demo seed under-covered itself: the general per-encounter medication loop in `hospitalData.ts` cycles through 5 drug names, but only 2 of them (Amoxicillin, Metformin) had a seeded mapping; Paracetamol, Atorvastatin, and Omeprazole did not. Every real dispense attempt for an unmapped drug throws `UnmappedDrugItemError`.
- **P0-B**: `allocatePayment` (`src/lib/hospital/billing/payments.ts`) computed the invoice's allocated total by summing `PaymentAllocation` rows in memory, checked it once, then only CAS-guarded the `Payment` side. `Invoice` had no stored allocation total at all. Confirmed via code trace: Postgres default isolation is READ COMMITTED, no `SELECT ... FOR UPDATE` exists anywhere in the codebase, and the existing concurrency test (`scripts/verify-postgres-billing-concurrency.ts` case 2b) only covered the *same*-Payment race, not the actual reported bug (two *different* Payments racing the same Invoice).
- **P0-C**: `administerMedication` (`src/lib/hospital/medicationLifecycle.ts`) did `findUniqueOrThrow` → check `status === "DUE"` → plain `update()`, not the guarded-`updateMany`+count-check idiom every sibling CAS function in this codebase uses (`bed.ts`, `invoices.ts`, `purchaseOrders.ts`, `confirmAppointment`). The function's own doc comment claimed concurrency safety; it was false as implemented.
- **P0-D**: Full trace of `HospitalShell.tsx`'s `NAV_BY_ROLE` → the Server Component layout → the render loop found no code defect. Diagnostics and Inventory are structurally identical to working nav groups (Beds, Billing) — same shape, no wrapping condition, no duplicate/stale nav definition, no client/server role-fetch mismatch, single source of truth. This was consistent with the code-level conclusion that the discrepancy was environmental, not a source defect.

## 4. Root causes

- **P0-A**: the mapping-creation function (`linkMedicationToItem`) was built and correctly used by seed data, but Phase 6A shipped no API route to call it at runtime — the "pipe" between medication and inventory was wired but never connected to anything an admin could actually use.
- **P0-B**: `Invoice` was designed with allocation as a purely computed aggregate (`SUM(PaymentAllocation.amountMinor)`), with no analog to `Payment.allocatedMinor`'s guarded running cache. The one-shot in-memory sum-then-compare has an unavoidable TOCTOU gap between the read and either payment's eventual commit.
- **P0-C**: `administerMedication` was written before the guarded-`updateMany` idiom became the codebase's established convention (or simply missed it) and was never retrofitted, despite its own comment claiming otherwise.
- **P0-D**: no code-level root cause was found. Confirmed via live HTTP verification (§12) that a fresh rebuild renders correctly across every tested role — consistent with a stale dev-server/build-cache artifact from an earlier investigating session, not a persistent defect.

## 5. Fixes

**P0-A** — `src/lib/hospital/inventory/itemMedicationLink.ts`: `linkMedicationToItem` now validates the target item exists, is `active`, is `category === "MEDICATION"`, and belongs to the same facility (or is a global item) via the existing `assertItemInFacility` helper (Phase 6A's own IDOR-closing pattern) before creating the link. New route `src/app/api/hospital/inventory/medication-links/route.ts` (GET list, POST create) follows the exact `items/route.ts` shape: `requireFacilityStaff("inventory:item:manage", facilityId)` → validate → `prisma.$transaction` → `recordAuditEvent("hospital.inventory.medicationLinked", ...)`. Seed data (`hospitalPhase6a.ts`) extended to map all 5 general-loop drug names, not just 2.

**P0-B** — `Invoice.allocatedMinor` (new `Int @default(0)` column) is a guarded running total, atomically maintained by a single conditional `UPDATE ... WHERE "allocatedMinor" + $amount <= "totalMinor"` (via `tx.$executeRaw`) inside the same transaction as the pre-existing `Payment`-side CAS loop — the same threshold-guarded-UPDATE idiom `stockBalance.ts`'s `atomicDecrementOnHand` already uses for on-hand quantity, not a new primitive. `refreshInvoicePaymentStatus` now reads `Invoice.allocatedMinor` directly instead of re-summing allocations.

**P0-C** — `administerMedication` now does `tx.medicationAdministration.updateMany({ where: { id, status: "DUE" }, data: {...} })`, throws the existing `AdministrationNotDueError` if `count !== 1`, then re-fetches the row — same idiom as `bed.ts`/`invoices.ts`/`purchaseOrders.ts`. No API contract change; the order-status/witness checks above it stay a plain read (a different aggregate).

**P0-D** — no code change (none was needed); resolved by live verification (§12).

**Incidental hardening found during Postgres validation**: `linkMedicationToItem`'s app-level duplicate check has the same TOCTOU shape as every other "check-then-create" function in this codebase; it now also catches the `MedicationItemLink`'s own `@@unique([facilityId, drugNameKey])` P2002 violation and maps it to the same clean `BadRequestError`, matching the established `isDuplicateCurrentResultError`/`isDuplicateActiveStudyError`/`isTariffExclusionViolation` pattern used elsewhere. Verified by a genuine `Promise.all` race in `scripts/verify-inventory-e2e.ts` (brief §8 gate #4).

## 6. Database invariants

- `SUM(PaymentAllocation.amountMinor WHERE invoiceId = X) <= Invoice.totalMinor` for every invoice, atomically enforced (P0-B).
- Exactly one non-terminal `MedicationAdministration` transition per row per call; `status` only ever moves out of `DUE` once (P0-C).
- `MedicationItemLink` has at most one row per `(facilityId, drugNameKey)` scope (pre-existing `@@unique`, now also defended against genuine concurrent creation, not just sequential).
- Cross-facility `MedicationItemLink` creation is impossible — `itemId` must resolve to the same facility as the link's scope, or be a global item (P0-A).

## 7. Idempotency behavior

`allocatePayment` still has no client-supplied idempotency key (unchanged scope); a genuine duplicate concurrent request is now safely resolved by the interaction of the new invoice-side guard and `PaymentAllocation`'s pre-existing `@@unique([paymentId, invoiceId])` — proven by CASE 4 in §9 (exactly one logical allocation, no double-counted totals, transaction rolls back cleanly on the loser). `administerMedication` has no idempotency key either; retries are now safely resolved by the `status: "DUE"` guard itself — a retry after a successful first attempt cleanly hits `AdministrationNotDueError` (CASE C, §9). `linkMedicationToItem` duplicate requests are now safely resolved by the `@@unique` constraint plus the new P2002 catch.

## 8. Concurrency strategy

No new concurrency primitive was introduced. Every fix reuses one of this codebase's two established idioms:
1. **Guarded `updateMany` + count check** (equality CAS, for enum-like/exact-match fields) — used for P0-C.
2. **Threshold-guarded atomic `UPDATE`** (for a running-total-vs-cap check) — used for P0-B, mirroring `StockBalance`'s `atomicDecrementOnHand`.
3. **DB-level `@@unique` + P2002 catch** — used to harden P0-A's duplicate-link path, mirroring `isDuplicateCurrentResultError`/`isDuplicateActiveStudyError`/`isTariffExclusionViolation`.

## 9. PostgreSQL race-test results

Disposable `postgres:16-alpine` container, isolated port/credentials, synthetic seed data only. The pre-existing `prisma/migrations-postgres-baseline/` history (originally created in Phase 4.5, incrementally extended by Phase 5 and Phase 6A) was extended with one new incremental migration, `20260907160000_phase6_6_invoice_allocated_minor` (adds `Invoice.allocatedMinor` + backfill from existing `PaymentAllocation` rows) — all 6 migrations applied cleanly in order to a fresh database. **Correction note**: an earlier pass in this session mistakenly regenerated this folder from scratch via `prisma migrate diff --from-empty`, silently deleting the real committed incremental history (`git status` surfacing 5 "deleted" files caught this before it was committed). The original files were restored via `git checkout`, the new incremental migration was re-authored on top of them instead, and the full Postgres validation below was re-run end-to-end against the corrected, real migration history — the numbers below are from that corrected run.

| Script | Assertions | Result |
|---|---|---|
| `verify-postgres-scheduling.ts` (pre-existing) | 8 | 8/8 PASS |
| `verify-postgres-billing-concurrency.ts` (extended, +5 new P0-B cases) | 13 | 13/13 PASS |
| `verify-postgres-medication-concurrency.ts` (new, P0-C) | 6 | 6/6 PASS |
| `verify-postgres-bed-concurrency.ts` (pre-existing) | 6 | 6/6 PASS |
| `verify-postgres-appointment-concurrency.ts` (pre-existing) | 7 | 7/7 PASS |
| `verify-postgres-inventory-concurrency.ts` (pre-existing) | 9 | 9/9 PASS |
| `verify-postgres-procurement-concurrency.ts` (pre-existing) | 7 | 7/7 PASS |
| `verify-postgres-queue-concurrency.ts` (pre-existing) | 3 | 3/3 PASS |
| `verify-inventory-e2e.ts` (extended, +8 new P0-A cases incl. genuine race) | 26 | 26/26 PASS |
| `verify-inventory-security.ts` (pre-existing IDOR suite) | 8 | 8/8 PASS |
| **Total** | **93** | **93/93 PASS** |

P0-B's 5 required cases (all against genuinely different `Payment`s racing one `Invoice`, via `Promise.allSettled`):
- CASE 1 (₹1000/₹1000): one wins, final=₹1000. PASS.
- CASE 2 (₹600/₹600): one wins, final=₹600. PASS.
- CASE 3 (₹400/₹400): both win, final=₹800. PASS.
- CASE 4 (identical duplicate concurrent request): exactly one `PaymentAllocation` row, no double-counted totals. PASS.
- CASE 5 (three ₹500 payments): exactly two win, final=₹1000, never exceeds `totalMinor`. PASS.

P0-C's required cases (all via `Promise.allSettled` against a real dispensed, `ACTIVE` order created through the P0-A fix):
- CASE A (same scheduled dose, concurrent): exactly one success, one `AdministrationNotDueError`, exactly one `GIVEN` record. PASS.
- CASE B (different scheduled doses, concurrent): both succeed. PASS.
- CASE C (retry after success): cleanly rejected. PASS.
- CASE F (illegal order state): `MedicationOrderNotActiveError`. PASS.
- CASE G (audit): exactly one audit event for the winner. PASS.
- CASE H (no double side effects): exactly one `DispensingRecord`/`Charge`/`StockLedgerEntry` — administration races triggered none of their own (there are no downstream hooks on this path, confirmed still true). PASS.

## 10. Security/RBAC results

Verified live via `curl` against a freshly built `next start` production server (not just script-level): `HOSPITAL_ADMIN` can create a medication link (200); `NURSE` attempting the same request is rejected with 403 `"Missing permission: inventory:item:manage"`; an invalid `itemId` returns 404 `"Item not found."`; a non-`MEDICATION`-category item returns 400. New `roleHasPermission` assertion added to `permissions.test.ts` confirming only `HOSPITAL_ADMIN` holds `inventory:item:manage` (not `PHARMACIST`, not `NURSE`). All three P0 fixes keep deriving `facilityId` server-side via existing `requireFacilityStaff`/`findXInFacility`/`assertItemInFacility` helpers — no client-trusted ID was introduced anywhere.

## 11. Audit verification

New `AuditEventType` literal `"hospital.inventory.medicationLinked"` added and fired on every successful link creation with correct `facilityId` context. P0-C's CASE G proved exactly one audit event is recorded per successful administration even under a genuine concurrent race (the loser never reaches the audit call, since it throws before that point). P0-B's existing audit behavior (via `refreshInvoicePaymentStatus`'s status-transition audit trail) is unchanged; no new audit event type was needed since the fix only tightens an existing guard, it doesn't add a new mutation type.

## 12. Render/UI verification

Browser extension was unavailable this session, so verification fell back to the plan's stated contingency: a full clean rebuild (`rm -rf .next && next build && next start`) followed by authenticated `curl` requests (real session cookies via `/api/scholar-auth/login`) against the actually-rendered HTML, not the compiled JS chunk. Result: **the discrepancy did not reproduce.** Both `Inventory` and `Diagnostics` nav links render correctly for `HOSPITAL_ADMIN`, matching the known-working `Beds`/`Billing` control groups exactly (1 occurrence each). Spot-checked across `DOCTOR`, `PHARMACIST`, `NURSE`, `LAB_TECHNICIAN`, and `RADIOLOGY_TECH` — every role's nav matched `NAV_BY_ROLE`'s source-code definition exactly, with no anomalies. Direct API access (`/api/hospital/inventory/items`) also confirmed correctly gated. This is resolved as a transient dev-environment/cache artifact from an earlier investigating session, not a persistent defect — consistent with, and now confirmed beyond, the code-level investigation's conclusion. **Full interactive browser verification (click-through, console/network inspection) remains pending** since the Chrome extension wasn't connected this session; the HTTP-level proof is strong but is not a substitute for an actual browser render if a future session has the tooling available.

## 13. Remaining P1/P2 items (not touched this phase, in scope for a future gate)

- The same read-check-then-plain-`update()` TOCTOU shape found and fixed in `administerMedication` (P0-C) is also present in `medicationLifecycle.ts`'s shared `transition()` helper (used by `verifyMedicationOrder`/`rejectMedicationOrder`/`holdMedicationOrder`/`dispenseMedication`/`cancelMedicationOrder`) and in `appointment.ts`'s `cancelAppointment`/`markNoShow`/`checkInAppointment`. Found during this phase's own investigation; deliberately not fixed since only `administerMedication` was named in the brief and it carries the direct double-dosing risk. Should be closed before any domain that leans harder on high-frequency order-status transitions.
- `dispenseMedication`'s stock-issue idempotency is still keyed to a freshly generated `DispensingRecord` id per call (pre-existing, documented Phase 6A limitation, out of this gate's scope).
- The two residual facility-isolation gaps named in the Phase 6.5 audit (appointment booking's `patientId`/`doctorStaffId`, medication-order creation's `patientId`) were not touched — out of this gate's named P0 scope.
- No dedicated Procurement Officer role — unchanged.
- `MedicationItemLink`'s schema still keys only on drug name, not formulation/strength — a hospital stocking two strengths of the same drug as separate SKUs cannot express that with a single link per name. Noted during P0-A investigation as a real design gap, deliberately not redesigned (smallest-fix scope).
- Nursing assessment/charting, ADT admission/discharge taxonomy, silent bed-day-tariff revenue leak — all pre-existing Phase 6.5 P1 items, untouched.

## 14. Production implications

This phase closes the three specific correctness/safety bugs the Phase 6.5 audit found live in ordinary volume, and removes the practical blocker on Phase 6A's headline medication-inventory integration. It does **not** make Aarogya production-ready — TLS/security headers/rate limiting, backups/DR, connection pooling, and environment-separated config are all still unaddressed (pre-existing, out of scope). The Postgres schema itself remains "validated, not yet live" (`schema.prisma`'s active provider is still `sqlite` for local dev, by design, per the established one-time-swap validation procedure). Do not represent any part of this phase as a claim of general production readiness.
