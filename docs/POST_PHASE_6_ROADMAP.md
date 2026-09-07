# Aarogya Post-Phase-6 Architecture Reconciliation

Phase 6.5 audit gate. Read-only reconciliation of the repository as it stands after Phase 6A (Inventory + Procurement). No new product functionality was built as part of this milestone. This document is the deliverable.

## 1. Current Repository State

- Branch: `main`
- HEAD at audit start: `d96ec7e` ("feat(hospital-os): add inventory and procurement foundation")
- `origin/main`: `d96ec7e` (matches HEAD)
- Working tree: clean, no uncommitted changes
- Phase 6A commit present: yes, it is HEAD itself
- TypeScript (`tsc --noEmit`): clean, zero errors
- Tests (`vitest run`): 270/270 passing across 35 test files
- Build (`next build`): succeeds
- Lint (`eslint`): 3 pre-existing errors, 18 warnings, all unrelated to hospital-os or Phase 6A:
  - `src/components/ai/AiAssistantPanel.tsx:139` and `:186` (React Compiler purity rules: `setState` inside effect, `Math.random` during render), legacy consumer-app AI widget
  - `src/components/navigation/TopBar.tsx:118` (same `setState`-in-effect rule), legacy navigation
  - Remaining warnings are unused-var/`<img>` notices in legacy Android build assets and consumer UI, not hospital-os code

Per the audit rules, these pre-existing lint errors were left untouched; fixing them was outside this gate's scope and unrelated to the reconciliation.

The repository is buildable, type-safe, and its test suite is green. The baseline is healthy. The interesting findings are architectural, not baseline breakage.

## 2. Phase A Capability Matrix

| Capability | Status | Evidence | Major Gap | Priority |
|---|---|---|---|---|
| A1. Production database architecture | YELLOW | Postgres migration set exists (`prisma/migrations-postgres-baseline/`, 2551-line baseline SQL) and was validated end-to-end against a live Postgres 16 instance per `docs/PHASE_4_PRODUCTION_READINESS.md`. But `prisma/schema.prisma` still declares `provider = "sqlite"` as the live datasource; Postgres is a parked, manually-activated alternative, not the deployed default. No connection pooling config anywhere. No backup/restore or PITR (explicitly "NOT IMPLEMENTED" in the project's own docs). No environment-separated config (single `.env` shape for all environments). Seed script is genuinely production-safe (`assertSeedAllowed()` blocks seeding unless `NODE_ENV=production` is explicitly overridden). Idempotency keys and two Postgres GiST exclusion constraints (imaging scheduling, tariff overlap) are real DB-level guarantees. | No production deployment posture (pooling, backups, DR, config separation) exists yet; Postgres itself is validated but not wired live. | P2 (must precede real go-live, does not block further schema/domain work) |
| A2. Identity / EMPI | YELLOW | `Patient` has `uhid`, `dobPrecision`, `deceasedAt`, logical merge (`mergedIntoId`/`mergedFrom`/`mergedAt`) with an audited `PatientMergeRecord` and a real weighted-scorer duplicate-detection service (`src/lib/patient/duplicateDetection.ts`). `PatientIdentifier` (ABHA/insurance/external MRN) and `PatientEmergencyContact` exist as separate tables. | `PatientIdentifier` and `PatientEmergencyContact` have zero write paths anywhere in the API surface (confirmed by repo-wide grep and by the project's own `docs/MASTER_GAP_MATRIX.md`), modeled but unpopulated. There is no PATCH/edit endpoint for `Patient` at all, so no demographic/name/address history is possible because edits themselves are not possible. No guardian-relationship concept exists. Duplicate detection is UI-invoked on blur, not enforced server-side at registration. `deceasedAt` is never set or read by any code path. This is a real enterprise-shaped skeleton with the muscle not yet attached, closer to "modeled CRUD entity" than a genuine EMPI. | P1 |
| A3. ADT | YELLOW | `Admission`/`Transfer`/`Discharge`/request-layer (`AdmissionRequest`/`TransferRequest`) form a real, transactional, CAS-guarded, audited state machine (`src/lib/hospital/admission.ts`), gated on the encounter state machine, with a live discharge-barrier engine computing readiness from real clinical data (labs, imaging, referrals) rather than a stored flag. Bed transitions reuse the same CAS pattern. | No admission-type taxonomy (elective/emergency/daycare/maternity/pediatric/isolation), only generic `RequestPriority` and `WardType`. No discharge-type enum at all (routine/LAMA/DAMA/absconded/death/transfer); `dischargeSummary` is an untyped `Json?` field, and its only production caller hardcodes a static string (`DischargeCenter.tsx`), i.e. no real discharge-summary generation exists. No follow-up-appointment scheduling wired from discharge. No inter-facility transfer support (`Transfer`/`TransferRequest` have no destination-facility field). `deceasedAt` is never wired into a death-discharge flow. | P1 |
| A4. EMR / documentation | YELLOW | `ClinicalNote` has real immutable versioning: signed notes are never mutated, amendment creates a new row with `supersedesId` and flips the prior row to `SUPERSEDED`, enforced server-side. `ClinicalDocument` is a genuine metadata model (type/version/accessPolicy/author). `Referral` has its own dedicated model. | `ClinicalDocument` is metadata-only, no storage integration (`storageRef` is a nullable pointer to something external, unimplemented), no UI references it anywhere. No dedicated anesthesia-record, nursing-note, operative-note, or death-summary model, all folded into `ClinicalNote.type` as free-text strings. E-signature is a timestamp + author FK, not cryptographic. | P2 |
| A5. Nursing | RED (assessment/charting), YELLOW (the narrower slice that exists) | `NursingAssignment`, `ClinicalHandoff`, `CarePlan`/`CarePlanIntervention`, `IntakeOutputRecord`, `MedicationAdministration` (doubling as MAR with witness co-sign), and a generic `Task` engine all exist with real services, APIs, and at least one UI surface (`NurseTasks.tsx`). | A full-repo grep for fall-risk, pressure-injury/Braden/Morse, nutrition, mobility, mental-status, neuro, respiratory, wound, drain, or line-charting concepts returns **zero matches**, none of these standard nursing assessment/charting domains exist as data models anywhere. This is explicitly named in the evaluator's own roadmap as needing deeper implementation, and the audit confirms the gap is total, not partial, for this specific scope. | P1 |
| A6. Pharmacy | RED (drug master), GREEN (inventory engine, internally) | Phase 6A's `Item`/`ItemLot`/`StockBalance`/`StockLedgerEntry` inventory engine is genuinely comprehensive: batch, expiry, cost via PO/GoodsReceipt lines, location, movement, adjustment (with approval), wastage (with reason + approval), and real FEFO logic, with atomic-UPDATE concurrency proven against live Postgres races. | No `Drug`/`Formulary` model exists at all. None of generic name, brand, strength, form, route, manufacturer, barcode, HSN/GST, schedule classification, high-alert flag, or controlled-substance flag exist on `Item` (`isControlled` lives only on `MedicationOrder`, an order-level flag, not a drug attribute). More critically: the mapping table connecting a prescribed drug name to a stock `Item` (`MedicationItemLink`) has a service function to populate it but **zero call sites anywhere in the codebase**, no admin UI, no API route, no seed data creates this mapping. In the running product, every dispense attempt for every drug will throw `UnmappedDrugItemError` unless someone manually inserts rows via direct database access. Phase 6A wired the pipe between medication and inventory but shipped no way to connect it. | P0 (the integration is currently non-functional out of the box) |
| A7. Lab | YELLOW | Full order to collection to specimen to accession to processing to result to verify to amend to release lifecycle is real: guarded state machine, DB partial-unique indexes preventing double-release of the same test, DB-unique recollection linkage, facility-isolated, audited. Critical-value flag + acknowledgement workflow works. | No QC/calibration tracking, no analyzer/instrument interface, no maker-checker separation (the `LAB_TECHNICIAN` role holds both result-entry and result-verification permissions), no TAT/SLA metric, no external-lab referral model, no tube/container typing (specimen type is free text), and the accession-number generator is date+`Math.random()` with the database unique constraint as the only real safety net. This is a specimen/result tracker, not a full LIS. | P2 |
| A8. Radiology | YELLOW | Order to schedule to acquire to report to verify to amend to acknowledge lifecycle is real and marginally stronger than Lab: double-booking is prevented by a Postgres GiST exclusion constraint (not just an application check), and real maker-checker exists (`RADIOLOGY_TECH` can only enter, `DOCTOR` verifies/amends/acknowledges, though there is no dedicated `RADIOLOGIST` role, doctors act as verifiers). | Zero DICOM/PACS/RIS integration or stub anywhere in the codebase; modality type is a free string; "acquisition" is a timestamp and a screening checklist with no image or file reference. This is explicitly and correctly scoped out for now, not a hidden gap. | P3 (explicitly, correctly deferred) |
| A9. Billing / revenue | GREEN (one YELLOW caveat) | Unusually rigorous for this project stage: server-side effective-dated pricing (`Tariff`), DB-unique idempotency keys with conflict-safe raw inserts for payments/refunds, CAS-guarded invoice/claim state machines, enforced maker-checker for refunds (a same-approver guard fires even when one role holds both permissions), and full facility isolation. Claims/preauth/settlement flow correctly routes actual cash back through the same `Payment`/`PaymentAllocation` ledger rather than a shortcut. | Two concrete, real gaps: (1) if no `Tariff` row exists for a bed-day charge, the accommodation charge is silently skipped at discharge with no compensating alert or audit event, an unaudited revenue leak (unlike lab/imaging/pharmacy, which have a `GENERIC` tariff fallback); (2) the payment-allocation concurrency guard only CAS-protects the `Payment` row, not the `Invoice`'s running allocation total, see Critical Risks, this is a real over-allocation race, not just a design nit. | P1 (the over-allocation race; see section 11) |

## 3. Cross-Cutting Foundation Matrix

| Concern | Verdict | Evidence / Reasoning |
|---|---|---|
| PostgreSQL | VALIDATED, not yet live | See A1. Schema.prisma's active `provider` is still sqlite. |
| Migrations | IMPLEMENTED (fresh-DB), NOT IMPLEMENTED (SQLite-to-Postgres data carry-over) | Fresh-DB `prisma migrate deploy` proven against live Postgres; no ETL/data-migration tooling exists to carry existing SQLite rows forward. |
| Idempotency | Mostly SAFE, with named exceptions | Payments, refunds, admissions, discharge, procurement, and most inventory movements are protected by DB-unique idempotency keys or `ON CONFLICT DO NOTHING` inserts. Medication administration and medication dispensing are PARTIALLY SAFE (no idempotency key, check-then-act only). One inventory route (`inventory/stock/issue`) silently defeats its own idempotency mechanism by generating a fresh random `sourceId` when the caller omits one. Lab result release is PARTIALLY SAFE (pre-check, not a DB constraint, though a partial-unique index acts as a backstop for the exact race). |
| Concurrency | Mostly SAFE, two UNSAFE material findings | Bed transitions, appointment booking (Postgres advisory lock), stock-quantity updates, PO approval, and invoice status transitions are all genuinely CAS- or lock-protected and independently verified against live Postgres races via manual scripts (not part of CI). Two real, unguarded races exist: invoice payment-allocation over-allocation, and medication-administration double-recording. Both are detailed in section 11. |
| Facility isolation | Dominant pattern SAFE, two residual IDOR gaps | Roughly 20 routes sampled across patients, billing, beds, appointments, medication, lab, imaging, claims, and procurement consistently re-derive `facilityId` server-side and re-check the target row's ownership before acting, including a centralized `facilityScope.ts` helper used throughout the new inventory/procurement code. Two routes still trust a client-supplied *secondary* ID without cross-checking it against an already-verified primary entity: appointment booking accepts `patientId`/`doctorStaffId` without confirming they belong to the booking facility, and medication-order creation accepts `patientId` without confirming it matches the already-verified `encounterId`'s patient. |
| RBAC | IMPLEMENTED | Role-to-permission table (`src/lib/auth/permissions.ts`), server-derived session role, ~90 permission strings, dedicated tests. |
| ABAC readiness | NOT READY, one attribute exists | Authorization is RBAC plus one bolted-on tenant attribute (facility), plus a separately-coded patient-self-relationship check for the patient portal only. Department, staff-to-patient/encounter relationship, purpose-of-use, and time are entirely absent as authorization dimensions. Building full ABAC now would be premature; the RBAC+facility layer is solid enough to extend later. |
| Audit | YELLOW | `AuditEvent` has a ~200-variant closed type catalog and captures WHO/WHAT/WHEN/FACILITY/PATIENT/ENCOUNTER, but never BEFORE/AFTER diffs, IP, session ID, or request ID. There are two parallel write mechanisms: most domains call a shared `recordAuditEvent()` helper, but `medicationLifecycle.ts` writes audit rows directly via `tx.auditEvent.create()` inside its own transactions instead. Both paths land in the same table with the same shape, so medication mutations *are* audited (confirmed at ~10 call sites with specific line numbers), but the inconsistency in how they're written is itself worth consolidating. Patient-merge (`src/lib/patient/merge.ts`) is a real gap: no audit call at all for a highly sensitive PII operation outside its own internal merge-record. |
| Consent | YELLOW, functionally inert | `Consent` is a genuine first-class model (purpose/scope/status/version/expiry/audit), not a scattered boolean. But its own schema comment states plainly that no route checks consent before proceeding today, it is recorded but never enforced. |
| Tasks | YELLOW | `Task` is genuinely generic and already reused across three independent call sites (manual creation, lab specimen-collection, imaging prep) without redesign, which is real evidence it can extend to other domains. It has due dates and owner assignment, but no escalation chain, no persisted `OVERDUE` transition despite the enum value existing, and no recurrence engine (explicitly unimplemented). |
| Alerts | YELLOW/RED | A deterministic, on-read rule engine (`alertEngine.ts`) computes 11 categories of live operational alerts from real DB state, correctly facility-scoped. There is no persisted `Alert` model, no generic acknowledgement mechanism (acknowledgement only exists per-domain for critical labs/imaging/safety-warnings), no escalation beyond a louder severity label, and no retry/delivery-status/deduplication concept. |
| Notifications | RED | Does not exist as a system. No SMS/email/push provider, no `Notification` model, no external delivery code of any kind. The one UI component named "Notifications" reads from a disconnected legacy mock store unrelated to hospital-os. |
| Event architecture | LEVEL 1 | The project's own `docs/EVENT_ARCHITECTURE.md` states plainly that no event bus, queue, or pub/sub layer exists in code today; what exists is a request-scoped write-then-audit pattern. `AuditEvent` rows have no consumers, correlation ID, or causation ID. The alert engine is a separate polling mechanism, not an event listener. This is the correct level for where the project is; building anything past Level 1 now would be premature. |
| Documents | YELLOW | Covered in A4. Real metadata architecture, no storage/UI/e-signature depth. |

## 4. Phase 6A Assessment

**What is genuinely complete:** the generic Inventory (Item/Lot/StockBalance/StockLedgerEntry with real FEFO) and Procurement (Supplier/PurchaseOrder/GoodsReceipt) domains are architecturally sound. Concurrency is handled correctly and consistently (single atomic conditional UPDATEs for balances, CAS-guarded `updateMany` for every state transition), idempotency keys are DB-unique almost everywhere, and facility isolation is centralized in a reusable `facilityScope.ts` helper rather than repeated ad hoc per route. A cross-facility purchase-order-numbering bug and an inventory facility-isolation gap were found and fixed within this same phase (per `docs/PHASE_6A_INTEGRITY.md`), which is a healthy sign of the team's own review discipline.

**What is intentionally deferred, and correctly so:** item costing/valuation, automatic purchasing/reorder generation, and supplier/ERP integration are clean scope cuts with no partial or misleading implementation. Lab/Radiology consumption UI is a reasonable deferment since the underlying permission and API capability already exists; it is just missing a purpose-built screen.

**What must be fixed:**
1. `MedicationItemLink` has no creation path anywhere in the product. This is not a deferred nicety, it means the headline Phase 6A integration (medication dispense decrementing real stock) cannot function today without manual database intervention. This should be treated as a P0 before any further domain that assumes dispense works.
2. `dispenseMedication`'s stock-issue idempotency is keyed to a freshly generated `DispensingRecord` id on every call, so a genuine double-submit (not just a sequential retry) will double-decrement stock. This is openly documented as a known, accepted limitation in `docs/PHASE_6A_INTEGRITY.md`, but the document's own reasoning (that it mirrors an already-shipped Phase 5 billing pattern) does not hold: the billing side is protected by `Charge`'s own unique constraint, while physical stock has no equivalent protection here.
3. The claimed live-browser verification of the new Inventory and Diagnostics navigation is inconclusive: `docs/PHASE_6A_INTEGRITY.md` itself reports that both `next dev` and a production `next start` served a page missing both nav groups despite the compiled JS containing the correct markup, and this was never root-caused. Since this affects a pre-existing feature (Diagnostics) as well as the new one, it reads as a possible systemic issue rather than a cosmetic Phase 6A gap, and needs to be resolved (or at minimum re-verified) before treating the UI as shipped.
4. No dedicated Procurement Officer role exists; all approval-tier procurement permissions sit on the single `HOSPITAL_ADMIN` role. The same-actor guard prevents a single individual from self-approving but does not provide real separation of duties. Explicitly flagged by the implementer as something to fix before the next phase.

## 5. Domain Boundary Map

| Domain | Canonical owner | Notes |
|---|---|---|
| Identity | `User`, `HospitalStaffProfile` | Clean. |
| Patient | `Patient` + `PatientIdentifier`/`PatientEmergencyContact` | See A2 gaps. Legacy `/hospital`'s in-memory patient list is an unrelated, disconnected concept (see section 10). |
| Encounter | `Encounter` | Clean, single owner. |
| ADT | `Admission`/`Transfer`/`Discharge` (execution) + `AdmissionRequest`/`TransferRequest` (staging) | Clean request/execution split, not a duplicate. |
| Clinical | `ClinicalNote`, `Problem`, `Diagnosis`, `Vital` | Clean. |
| Nursing | `NursingAssignment`, `Task`, `ClinicalHandoff`, `IntakeOutputRecord` | Clean ownership; the domain itself is thin (see A5). |
| Medication | `MedicationOrder`, `MedicationAdministration`, `MedicationReconciliation` | Clean. |
| Pharmacy | `DispensingRecord`, `MedicationVerification` | Clean ownership; drug-master concept is entirely absent (see A6). |
| Lab | `LabOrder`, `LabResult`, `LabTestCatalog`, `Specimen` | Clean. |
| Radiology | `ImagingOrder`, `ImagingStudy`, `ImagingReport` | Clean. |
| Billing | `Charge`, `Invoice`, `BillingAccount`, `Tariff` | Clean single owner despite many related tables; none re-derive amounts independently. |
| Inventory | `StockBalance`, `Item`, `ItemLot`, `StockLedgerEntry` | Clean, with one minor watch item: `reorder.ts` computes its own on-hand aggregate instead of reusing the shared `computeAvailable()` helper. Not a bug today, worth consolidating before a second caller duplicates the same pattern. |
| Procurement | `PurchaseRequisition`, `PurchaseOrder`, `GoodsReceipt` | Clean. |
| Task | `Task` | Single model, genuinely reused across domains, no competing task table. |
| Alert | Computed on read via `alertEngine.ts` | Not persisted, so no drift risk by construction. |
| Audit | `AuditEvent` | Single model; see the two-write-path inconsistency noted in section 3. |
| Documents | `ClinicalDocument` | Clean; unrelated to `NotebookEntry` (student LMS notes), which is a separate bounded context worth naming clearly so it is never confused with clinical documentation. |
| Authorization | `rbac.ts`/`hospitalRbac.ts`/`patientRbac.ts` | Naming collision only: RBAC "authorization" and billing `PreAuthorization` are unrelated concepts sharing a word. Worth a glossary note, not a code change. |
| Interoperability | Not implemented | Only referenced in planning docs; no FHIR/HL7 code exists yet anywhere, so any future work here has a clean slate with no legacy shim to reconcile. |

**The only genuine competing source of truth in the entire codebase** is the legacy `/hospital` mock module (`useBedBookingStore`/`useHospitalOpsStore`), which fabricates bed counts, doctors, staff, and admissions entirely client-side, disconnected from the real `Bed`/`Admission`/`HospitalStaffProfile` Prisma tables. This is a real risk for future ICU/OT work if a developer builds against the wrong "Bed" concept by mistake. See section 10.

Outside of that, the domain boundaries are unusually disciplined for this project stage: nearly every apparent duplicate (two timeline builders, two facility-scope helpers, three document-like stores) turns out to be a documented, intentional specialization with an inline comment explaining the boundary, not accidental drift.

## 6. ICU Readiness

**Verdict: NEEDS-FOUNDATION-WORK.**

Ready today, reusable without change:
- Bed-level ICU classification (`WardType.ICU`/`HDU`/`NICU`/`PICU`, `Bed.isolationRequired`)
- Fluid balance (`IntakeOutputRecord` already models input/output by category, encounter-scoped)
- Per-metric threshold primitives (`VitalThreshold`, deliberately not a hardcoded score, a sound base for a future composite early-warning score)
- Nursing assignment linkage (`NursingAssignment`), though with no ratio-cap enforcement yet

Missing but additive (new models hanging off existing `Encounter`/`Patient`/`Bed`, not a restructuring of them):
- Equipment/ventilator tracking (no `Equipment` model exists at all; today "equipment" is only a generic inventory item category)
- Ventilator parameters, ABG, coded GCS/sedation scoring (the `Vital` model deliberately keeps `consciousness` free-text and was never meant to carry ICU-specific coded fields)
- IV infusion tracking (medication administration today is discrete-event, not continuous-rate)
- Device/line tracking (catheters, central lines, drains: no model exists)
- A composite early-warning score and a dedicated code-blue/rapid-response event type (the `Task` and handoff primitives generalize toward this but nothing exists yet)

None of the missing pieces require touching `Vital`, `MedicationOrder`, or `Bed` structurally. This is real, scoped, additive work, not an architectural blocker, but it has not been designed yet and should be before ICU workflow implementation starts.

## 7. OT Readiness

**Verdict: NEEDS-FOUNDATION-WORK, leaning NOT-READY for the surgical core specifically.**

Peripheral stages already have a home: implants/consumables can reuse `StockReservation` (which already supports patient/encounter-scoped holds), PACU can use the already-existing `WardType.OT_RECOVERY`, post-op orders reuse the generic `Order`/`CarePlan` primitives, and pre-op consent can use the existing `Consent` model's `PROCEDURE` purpose.

But the core surgical domain does not exist at all: there is no `Procedure`/`Surgery` model anywhere in the schema (the only traces are an `OrderType.PROCEDURE` enum value explicitly marked "for extensibility, zero rows this phase," and a free-text `PROCEDURE` note type). There is no theater/OT resource-scheduling model, though `ImagingResource` plus its Postgres GiST exclusion constraint is a proven, directly copyable pattern for it. No anesthesia-record model exists. No checklist model exists.

This is additive-but-substantial: several genuinely new models are needed (Procedure/Surgery, OT resource scheduling, anesthesia record, checklist), none of which require restructuring `Encounter`, `Order`, or `Item` as FK targets.

## 8. Blood Bank Readiness

**Verdict: NOT-READY, requires a specialized domain.**

The generic Inventory system (`Item`/`ItemLot`/`StockReservation`) is built for fungible, quantity-based stock (`Item.trackSerial` defaults to `false`, and there is no serial/unit-identity model at all). Blood products are fundamentally unit-identity-based: a specific bag must be crossmatch-tested and reserved against a specific patient, with component lineage back to a single donation and continuous cold-chain state. None of this can be bolted onto `Item`/`ItemLot` as field additions without effectively becoming a different model.

Recommendation: build Blood Bank as its own domain (`Donor`, `Donation`, `BloodTestResult`, `BloodUnit` with real unit-level identity and status, `Crossmatch`, `TransfusionReaction`), reusing proven *patterns* from this codebase (idempotency keys, facility scoping, the FEFO-by-expiry logic already written for general inventory, the patient-scoped reservation shape) rather than reusing the `Item`/`ItemLot` tables themselves.

## 9. India Interoperability Readiness

| Concept | Status | Reasoning |
|---|---|---|
| ABHA | NEEDS FOUNDATION | `PatientIdentifier` gives a linkage point, but it is untyped, unconstrained (no uniqueness on type+value), and unpopulated. Frontend mock UI shows ABHA fields that are entirely disconnected decorative mock data, not wired to the real model. |
| ABDM (overall) | NEEDS FOUNDATION | Only referenced in planning docs and marketing copy; no adapter/client code exists. |
| HFR | NOT READY | No field reserved for a facility-registry ID anywhere on `Facility`. |
| HPR | NOT READY | No field reserved for a professional-registry ID anywhere on `HospitalStaffProfile`. |
| HIP/HIU (ABDM consent artifact) | NEEDS FOUNDATION | The internal `Consent` model is versioned and auditable but has none of the ABDM-specific consent-artifact fields; would need extension, not a rebuild. |
| FHIR | NOT READY | Explicitly and repeatedly documented in the project's own architecture docs as out of scope; no resource-ID fields exist on any clinical model. Marketing copy implies FHIR compliance with no supporting code; that claim should not be repeated externally. |
| NHCX | NEEDS FOUNDATION | Internal `Claim`/`ClaimLine` models exist for domestic insurance claims but carry no NHCX-shaped fields. |
| DICOM | NOT READY | Explicitly deferred; no StudyInstanceUID or PACS-reference field on any imaging model. |
| PACS | NOT READY | Same as DICOM. |
| DPDP / privacy | NEEDS FOUNDATION | De-identification utilities exist but are scoped narrowly to a student-education data pipeline, not general hospital-EMR DPDP compliance. |
| ABAC | NOT READY | Authorization is role-only; would need structural work to add attribute/context-based gating (see section 3). |

Nothing here should be started this phase. The point of this table is only to confirm none of these integrations were half-built in a way that would create a false impression of readiness, and none were found to be.

## 10. Legacy Architecture Assessment

The old `/hospital` module (`src/app/hospital/page.tsx` plus 8 tab components, roughly 2,200 lines total) is a fully client-side mock hospital dashboard with no Prisma or API backing whatsoever. It predates hospital-os and was deliberately left in place per an explicit comment in the schema and in `docs/ENTERPRISE_HOSPITAL_ARCHITECTURE.md`, which states that overwriting it would have violated an earlier instruction not to break existing functionality.

It is still reachable: the login flow actively routes a `"hospital"` role literal to `/hospital`, and that role is still offered at signup. It shares no models or services with hospital-os, but its `useBedBookingStore` is also consumed by the admin dashboard's capacity widget and a patient-facing "find a bed" card, both of which currently display fabricated, non-live numbers rather than real facility data.

**Recommendation: REDIRECT-AND-DEPRECATE**, in this order, to avoid breaking either the legacy role or the two real consumers of the shared store:
1. Stop issuing the `"hospital"` role at signup, or redirect it into real hospital-os RBAC roles.
2. Turn `/hospital` into a redirect stub pointing at `/hospital-os/login`.
3. Re-point `BedBookingCard.tsx` and the admin capacity widget onto a real `/api/hospital/beds` read instead of the mock store.
4. Delete `src/app/hospital`, `src/components/hospital`, `useBedBookingStore.ts`, and `useHospitalOpsStore.ts` (roughly 2,200 lines removed).

This is not urgent for continued domain work (nothing in hospital-os depends on it), but it is a real source of confusion risk for anyone approaching the codebase fresh, including whoever eventually builds ICU/OT bed logic, and should happen before those phases rather than after.

## 11. Critical Risks

**P0 (blocks safe development of the next phase)**

1. **Medication-to-inventory link table has no creation path.** `MedicationItemLink` (the table `dispenseMedication` needs to resolve a drug name to a stock item) has an exported function to populate it but zero call sites anywhere in the API, admin UI, or seed data. Every real dispense attempt will throw `UnmappedDrugItemError` today. This means Phase 6A's headline integration is currently unusable without manual database intervention.
2. **Invoice payment-allocation over-allocation race.** `allocatePayment`'s over-allocation check reads the invoice's current allocation total once, outside any lock or CAS guard, while only the `Payment` row itself is CAS-protected. Two concurrent payment-allocation calls against the same invoice (a realistic scenario when multiple front-desk/billing staff work the same encounter) can both pass the stale check and both commit, allowing an invoice to be over-allocated beyond its total. This is a live financial-integrity bug, not a theoretical one.
3. **Medication administration double-recording race.** `administerMedication` reads status, checks it, then performs a plain (non-CAS) update, unlike every sibling function in the same file (bed, appointment, invoice, PO all use guarded `updateMany`). A genuine double-click or retry can record the same dose as given twice. The route's own doc comment claims this is concurrency-safe; it is not, as implemented. This has direct patient-safety and controlled-substance implications.

**P1 (should be resolved before starting the next major clinical domain: ICU/OT/Blood Bank)**

4. `dispenseMedication`'s stock-issue idempotency is keyed to a freshly generated record ID each call, so a genuine double-submit will double-decrement stock (distinct from the P0 above, and already acknowledged in Phase 6A's own docs, but its risk-equivalence reasoning to a prior billing pattern does not actually hold).
5. Two residual facility-isolation gaps: appointment booking does not verify that the supplied `patientId`/`doctorStaffId` belong to the booking facility; medication-order creation does not verify the supplied `patientId` matches the already-verified encounter's patient.
6. No dedicated Procurement Officer role; all procurement approval permissions sit on a single `HOSPITAL_ADMIN` role, with only a same-actor guard as separation of duties.
7. Nursing assessment/charting (fall risk, pressure injury, nutrition, pain, mobility, mental status, neuro/respiratory/wound/drain/line charting) is entirely absent. This is itself a Phase A item (#5 Nursing) that the evaluator's own roadmap places before Phase B, and it is a direct prerequisite for ICU flowsheets.
8. ADT discharge type/summary is an untyped JSON blob with a hardcoded production string, and there is no admission-type taxonomy. This undercuts "finish the core" before adding clinical depth.
9. Silent bed-day charge skip when no tariff exists: an unaudited revenue leak, not merely a UX nit, because nothing alerts anyone it happened.
10. The `inventory/stock/issue` route silently defeats its own idempotency protection when the caller omits a `sourceId`, generating a fresh random one on every call.
11. The Inventory/Diagnostics navigation live-render discrepancy documented in Phase 6A's own integrity notes was never root-caused, and affects a pre-existing feature as well as the new one.

**P2 (important, can wait)**

12. Pharmacy drug master (formulary, schedule classification, high-alert flags) does not exist; relevant for controlled-substance compliance eventually, not blocking architecture work now.
13. Lab lacks QC/calibration tracking and maker-checker separation between result entry and verification.
14. Production database posture (connection pooling, backup/restore, PITR, environment-separated config) is unaddressed; must precede a real production go-live, not further domain development.
15. `AuditEvent` has two parallel write paths (a shared helper, and direct writes in `medicationLifecycle.ts`); both work today, but should be consolidated to avoid future drift.
16. Legacy `/hospital` retirement, per section 10's sequencing.
17. Patient identity gaps (A2): no patient-edit endpoint, unpopulated identifier/emergency-contact tables, no guardian concept.

**P3 (future, correctly out of scope for now)**

18. Item costing/valuation, automatic purchasing, supplier/ERP integration: all explicitly and correctly deferred with no partial implementation creating false confidence.
19. Radiology PACS/DICOM integration: explicitly and correctly deferred.
20. ABDM/ABHA/FHIR/NHCX/HFR/HPR integration, ABAC, and any event-bus/outbox infrastructure beyond the current Level 1.

## 12. Recommended Next Sequence

NEXT:
Fix the three P0 items: wire a real `MedicationItemLink` creation path (an admin screen or seed-time mapping is enough, it does not need to be elaborate), add the missing invoice-side CAS guard to `allocatePayment`, and convert `administerMedication` to the same guarded-`updateMany` pattern already used everywhere else in that file. Also re-verify (or root-cause) the Inventory/Diagnostics live-browser navigation discrepancy before treating either feature as shipped.

THEN:
Close the remaining P1 items: the two residual facility-isolation gaps (appointment, medication order), a dedicated Procurement Officer role, structuring ADT admission-type and discharge-type/summary properly, and fixing the silent bed-day-tariff revenue leak (at minimum, raise an audit event and a command-center alert when it happens, even before deciding on a full fallback-tariff policy).

THEN:
Build out the Nursing assessment/charting layer (fall risk, pressure injury, nutrition, pain, mobility, mental status, neuro/respiratory/wound/drain/line). This is still Phase A work, not Phase B, and ICU flowsheets depend on it existing first.

THEN:
Design (schema only, no workflow/UI yet) the additive ICU primitives identified in section 6: Equipment/EquipmentAssignment, coded GCS/sedation fields, VentilatorSetting, DeviceLine, Infusion. Do the same for the OT primitives identified in section 7 (Procedure/Surgery, OT resource scheduling with the imaging-style exclusion constraint, anesthesia record, checklist) if OT is the next domain chosen, or scope Blood Bank's dedicated domain per section 8 if that is chosen instead.

THEN:
Re-run a short version of this reconciliation gate to confirm the P0/P1 punch list actually closed, before starting real ICU/OT/Blood Bank workflow implementation.

## 13. Explicitly Deferred Items

Do not build yet: ICU, OT, Blood Bank, Workforce, Facilities, EMPI, ABDM, FHIR, DICOM/PACS integration, NHCX, ABAC, any event-bus/message-queue/outbox infrastructure beyond current Level 1, a workflow/rules engine, AI features, item costing/valuation, automatic purchasing, supplier/ERP integration, and Phase 6B generally.

## 14. Decision Gate

**Is Aarogya ready to begin ICU implementation?**

**NO.**

The underlying architecture does not need surgery: bed/ward/encounter/task/threshold primitives are sound, ICU-specific additions are additive rather than restructuring, and the evaluator's instinct to finish the core before adding clinical depth is well supported by this audit. But three things need to close first, specifically because ICU will multiply exactly the kind of high-frequency, high-stakes mutations where this audit found live bugs: a real invoice over-allocation race and a real medication double-administration race exist today in ordinary OPD/IPD volume; an ICU unit would hit both far harder, faster. Second, Phase 6A's own medication-to-inventory integration cannot function in production today because the linking table has no way to be populated, and ICU will lean on medication/infusion tracking more than any domain built so far. Third, Nursing assessment/charting, an explicit Phase A prerequisite in the evaluator's own roadmap, is completely absent, and ICU flowsheets are built on exactly that foundation.

This is a bounded punch list, not a rebuild. Closing the P0 items and the Nursing gap, then doing the additive ICU schema design in section 6, is a reasonably short path to a genuine "YES." This audit's conclusion is that Aarogya is close, not far, but not there yet.
