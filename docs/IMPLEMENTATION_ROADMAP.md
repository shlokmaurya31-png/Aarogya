# Implementation Roadmap — Phases 1–10

Sequencing for all work after Phase 0. Each phase should be followed by an
audit turn against the actual repository (per the user's stated
phase → audit → phase cadence) before the next phase's scope is finalized
— the detail below is a starting proposal for each phase, not a fixed
contract, since later phases will be re-scoped based on what Phase 1's
audit actually finds.

---

## PHASE 1 — Platform Foundation + Unified Clinical Core

**Objective**: collapse the "three islands" problem
(`docs/AAROGYA_TARGET_ARCHITECTURE.md` §2) enough that the original
Patient/Doctor prototype reads and writes through the same real backend
Hospital OS already has, without breaking either existing experience
during the transition.

- **Prerequisites**: this Phase 0 audit (done).
- **Database**: activate `Role.PATIENT`/`Role.DOCTOR` for real accounts;
  decide whether a "doctor" in this sense is a `HospitalStaffProfile` at
  a facility (likely yes, for consistency) or a new lighter-weight
  profile; add whatever `Patient`-linkage a self-registering patient
  needs (a `Patient` row may need to exist without ever having an
  `Encounter` yet, unlike today's Hospital OS flow where a `Patient` is
  always created by staff).
- **Backend**: new `/api/patient/*` routes (self-service registration,
  own-record read) with a `requirePatientSelf()`-style RBAC helper
  mirroring `requireFacilityStaff()`/`requireVerifiedStudent()`.
- **Frontend**: migrate `/dashboard`'s patient view onto real API calls,
  behind a feature flag or a parallel route, so the existing mock
  experience isn't broken until the new one is verified working
  end-to-end (mirrors how Scholar/Hospital OS were built additively
  alongside, not on top of, the original system).
- **Workflows**: patient self-registration → login → view own longitudinal
  record (read-only at first) → book/see appointments (Phase 2 territory,
  stub acceptable here).
- **Integrations**: none new.
- **Security**: close S-02 (rate limiting on `/api/scholar-auth/login`,
  which becomes even higher-value once real patients use it) and S-03
  (session revocation) — both flagged CRITICAL/HIGH in
  `docs/SECURITY_AUDIT.md`, both are foundation blockers for a phase that
  onboards a new, larger user population (patients) onto the same auth
  system.
- **Testing**: integration tests for the new patient-self-access RBAC
  boundary (a patient must never read another patient's record — this is
  the first time "tenant" scoping means "one individual," not "one
  facility," a genuinely new authorization shape worth dedicated tests).
- **Demo data**: seed 5-10 patient accounts linked to existing
  Hospital OS `Patient` rows.
- **Definition of done**: a patient can log in with a real account and
  see real data that a doctor entered through Hospital OS, in one
  database, with no Zustand-only state involved in either direction.

## PHASE 2 — Patient Flow + OPD + Emergency + Admissions

**Objective**: real scheduling/queueing (currently entirely missing, per
`docs/MODULE_BOUNDARIES.md` #2) and OPD/ED depth beyond today's generic
`Encounter` creation.

- **Prerequisites**: Phase 1's unified patient identity.
- **Database**: `Appointment` model (real, replacing the prototype's
  client-only interface); a lightweight `Queue`/`QueueEntry` concept for
  token-based ordering (or a computed view over `Encounter.registeredAt`
  ordering, if a real queue table proves unnecessary — decide during
  implementation, don't assume).
- **Backend**: `/api/hospital/appointments/*`; ED-specific board view API
  distinct from the generic encounter list.
- **Frontend**: appointment booking UI (patient-facing and front-desk-
  facing), ED board, token/queue display.
- **Workflows**: the brief §202 "final product test" scenario
  (registration → triage → doctor → orders → results → disposition) —
  already partially verified live for Hospital OS's existing pieces; this
  phase closes the "how did the patient get an appointment in the first
  place" gap before that test.
- **Integrations**: none new.
- **Security**: appointment booking is a good IDOR-test surface (can
  patient A see/cancel patient B's appointment?) — add to the test suite.
- **Testing**: appointment CRUD + queue-ordering correctness under
  concurrent bookings.
- **Demo data**: a realistic day's OPD schedule (30-50 appointments across
  the 8 seeded doctors).
- **Definition of done**: a patient can book an appointment, a front-desk
  role can check them in, and that check-in becomes a real `Encounter` —
  closing the loop Hospital OS currently starts mid-stream (an `Encounter`
  today is created directly by staff with no preceding appointment).

## PHASE 3 — Doctor + Nursing + Medication + Pharmacy

**Objective**: deepen the two modules already `PARTIAL`
(`docs/MODULE_BOUNDARIES.md` #7, #9) rather than building new ones.

- **Prerequisites**: Phase 1-2.
- **Database**: generic `Task` entity (see
  `docs/TARGET_DOMAIN_ARCHITECTURE.md` §2.3); `Referral`, `CarePlan`
  models; Pharmacy inventory model (`PharmacyItem`/`StockMovement`, per
  the original brief §29, scoped down to what dispensing actually needs).
- **Backend**: `/api/hospital/tasks/*` (generalizing today's computed-view
  nurse tasks), `/api/hospital/referrals/*`, `/api/hospital/pharmacy/*`
  (dispensing against a `MedicationOrder`, decrementing inventory).
- **Frontend**: nursing handover UI (SBAR format, brief §24), care-plan
  view, pharmacy dispensing queue.
- **Workflows**: doctor requests consult → referral created → consultant
  notified → consult performed → note signed (brief §161); pharmacy
  receives medication order → verifies → dispenses → nurse administers
  (currently the pipeline skips straight from order to administration
  with no pharmacy step).
- **Security**: `PHARMACIST`'s `medication:verify` permission already
  exists unused (see `docs/MODULE_BOUNDARIES.md` #9) — wire it to a real
  route rather than adding a new permission.
- **Testing**: task-generation correctness (does every task type produce
  the right due-date/owner), referral state-machine tests.
- **Demo data**: expand seeded medication orders to flow through a real
  pharmacy dispensing step.
- **Definition of done**: the brief §202 scenario's "pharmacy receives
  medication order" step becomes real (currently implicit/skipped).

## PHASE 4 — Laboratory + Radiology + Diagnostics

**Objective**: deepen Lab/Radiology (`PARTIAL`, narrow) toward the brief's
full workflow (§27-28) — sample lifecycle, not just order→result.

- **Database**: `LabSample` (collection, accession, rejection tracking),
  structured reference ranges (`{low, high}` on a test-catalog entity,
  closing the `docs/CLINICAL_SAFETY_AUDIT.md` §5 auto-critical-detection
  gap).
- **Backend**: sample collection/accession/rejection routes; a
  `LabTestCatalog`/`ImagingStudyCatalog` reference table (currently
  `testName`/`studyDescription` are free-text per order, with no shared
  catalog — every order re-types the test name).
- **Integrations**: PACS/DICOM adapter interface (architecture only, per
  brief §28 — "provide adapter interfaces... do not implement a fake
  PACS," matching Scholar's `ClinicalCaseProvider` precedent).
- **Security**: sample-rejection and re-collection workflows are a common
  real-world source of patient-mismatch errors — worth explicit
  patient-identity-confirmation UI at collection (brief §103).
- **Testing**: reference-range-based auto-critical-flagging correctness.
- **Definition of done**: a lab result's `isCritical` flag can be set
  automatically from a structured reference range, not only by human
  judgment at entry (human override remains available, per the
  established safety-check shape).

## PHASE 5 — Billing + Insurance + Revenue Cycle

**Objective**: close the biggest Financial Core gap (`docs/CORE_PLATFORM_ARCHITECTURE.md`)
— payments and insurance are entirely missing today.

- **Database**: `Payment` model, `InsurancePolicy`/`Claim`/`ClaimEvent`
  (claim states: `DRAFT/SUBMITTED/UNDER_REVIEW/QUERY/APPROVED/
  PARTIALLY_APPROVED/REJECTED/SETTLED`, per the original brief §35);
  `Charge.amount`/`Bill.totalAmount`/`Bill.paidAmount` migrate `Float` →
  `Decimal` (flagged as production-blocking in
  `docs/DATABASE_PRODUCTION_READINESS.md` §9 — do this here, not later).
- **Backend**: `/api/hospital/payments/*`, `/api/hospital/insurance/*`
  (preauth, claim submission/status), a payment-adapter interface (brief
  §166 — UPI/card/cash/net-banking, adapter pattern, no hardcoded
  provider).
- **Workflows**: the `EpisodeOfCare` gap
  (`docs/TARGET_DOMAIN_ARCHITECTURE.md` §2.1) becomes a real requirement
  here — if consolidated billing across a multi-encounter episode is
  wanted, build the entity now, not before.
- **Security**: payment webhook signature verification (whichever gateway
  is chosen); claim data is financially sensitive — audit every state
  transition (the `AuditEvent` pattern already established extends
  naturally here).
- **Testing**: idempotency tests for payment webhooks specifically (brief
  §130 — "critical APIs must be idempotent... especially payments").
- **Definition of done**: `Bill.paidAmount` is a real, payment-backed
  number for the first time; a claim can be submitted and tracked through
  its full state machine.

## PHASE 6 — OT + ICU + Blood Bank + Inventory + Procurement + Facilities + Workforce

**Objective**: the largest single phase — six modules that are all
currently `MISSING`, grouped together because they share the "physical
resource scheduling/tracking" shape (an OT slot, an ICU bed's ventilator,
a blood unit, a stock item, a purchase order, a room, a shift are all
variations of "a scarce resource with a state machine and an owner").

- **Database**: `Procedure` + OT scheduling models; ICU flowsheet/
  ventilator-parameter models; `BloodUnit`/`Crossmatch`/`Transfusion`;
  `InventoryItem`/`StockMovement`/`PurchaseOrder`/`Supplier`; `Room`
  entity (closing the `docs/TARGET_DOMAIN_ARCHITECTURE.md` §1 gap);
  `Equipment`/`MaintenanceTicket`; `Roster`/`Shift`/leave models.
- **Recommendation**: do not build all six simultaneously despite grouping
  them in one phase name — sequence sub-phases (6a OT, 6b ICU, 6c Blood
  Bank, 6d Inventory/Procurement, 6e Facilities, 6f Workforce) with an
  audit checkpoint between each, following the same phase→audit cadence
  as the top-level roadmap. This phase is a strong candidate for further
  splitting once Phase 5's audit informs actual priority order (which of
  these six a real hospital customer would ask for first).
- **Clinical safety note**: ICU ventilator-parameter tracking and Blood
  Bank crossmatch/transfusion are the two highest clinical-risk additions
  in this entire roadmap — per `docs/CLINICAL_SAFETY_AUDIT.md`'s
  established principle, do not build transfusion-reaction or ventilator-
  weaning decision logic without real clinical reference data; track
  state and support human decision-making only.
- **Definition of done**: defer to per-sub-phase DoD, defined when each
  sub-phase is actually scoped (not speculatively here).

## PHASE 7 — Quality + Patient Safety + Infection Control + Medical Records + Compliance

- **Database**: `Incident`/`CorrectiveAction` (CAPA), infection-control
  event models, document-completeness tracking.
- **Backend**: incident reporting/triage/RCA workflow (brief §46-47 — "do
  not automatically blame individuals," a real design constraint on the
  RCA UI, not just documentation).
- **Wires up existing unused data**: `Bed.isolationRequired` (currently
  unenforced, see `docs/CLINICAL_SAFETY_AUDIT.md` §3) becomes real —
  Infection Control's first workflow should be enforcing/warning on
  isolation-bed mismatches at admission time, since the data already
  exists and just isn't read anywhere.
- **Compliance framing**: per the original brief §47/§134, build toward
  "accreditation readiness" (policy library, evidence repository, audit
  checklist, quality indicators, CAPA) — never claim NABH/ABDM/HIPAA
  certification in any UI copy this phase produces.
- **Definition of done**: an incident can be reported, triaged, assigned,
  and closed with a corrective action, end-to-end, DB-backed.

## PHASE 8 — Hospital Command Center + Analytics + Operational Intelligence

**Objective**: the Command Center currently gives live current-state
snapshots only (`docs/CORE_PLATFORM_ARCHITECTURE.md`'s Intelligence Core
section) — this phase adds real historical analytics and drill-down.

- **Database**: a time-series-friendly aggregation strategy — likely
  periodic materialized snapshots (e.g. hourly bed-occupancy rows) rather
  than trying to compute historical trends from live-table scans, which
  degrades as data grows.
- **Backend**: `/api/hospital/analytics/*` with real drill-down (facility
  → department → unit → day → encounter, per brief §81).
- **Events becomes real here**: this is the first phase where
  `docs/EVENT_ARCHITECTURE.md`'s "when this becomes necessary" trigger #4
  (durable, replayable event stream for point-in-time reporting) actually
  fires — build the outbox/event log here, not before.
- **Definition of done**: "what was bed occupancy at 3pm yesterday" is
  answerable — the concrete test for whether real analytics (vs.
  current-state snapshots) exists.

## PHASE 9 — AI + FHIR + HL7 + DICOM + ABDM + External Integrations

- **Database**: `code`/`codeSystem` terminology columns
  (`docs/TARGET_DOMAIN_ARCHITECTURE.md` §3); ABDM linkage via
  `PatientIdentifier` (already modeled, unpopulated).
- **Backend**: real `ClinicalCaseProvider`-pattern adapters (per
  `docs/AAROGYA_TARGET_ARCHITECTURE.md` §4, the Scholar/Hospital-OS
  connection point — de-identified teaching cases from real Hospital OS
  encounters, through the existing `caseSanitizer.ts` pipeline, becomes
  possible only once there's real clinical data worth de-identifying);
  Hospital AI copilot using Scholar's `AIProvider` pattern.
- **Never claim certification** — ABDM/FHIR/HL7/DICOM work here is
  integration-readiness, not a certification claim, per brief §134/§135.
- **Definition of done**: at least one real external integration
  (whichever the business prioritizes — likely ABHA linkage) working
  end-to-end against a sandbox/test environment, not just an interface.

## PHASE 10 — Enterprise SaaS + Multi-Hospital + Production Infrastructure

- **Database**: Postgres cutover (per
  `docs/DATABASE_PRODUCTION_READINESS.md` §6's recommended procedure —
  fresh migration history, not ported SQLite migrations); organization-
  level master patient index (`docs/TARGET_DOMAIN_ARCHITECTURE.md` §4.1),
  gated on a governance decision, not just a schema change.
- **Backend**: subscription/license/seat-management models (brief §117-
  118 — "do not hardcode pricing"); usage analytics scoped so no
  cross-tenant patient data is ever exposed to Aarogya's own platform
  admins (brief §119's explicit constraint).
- **Security**: this is where S-02 (rate limiting)/S-03 (session
  revocation) absolutely cannot remain open — re-verify both are closed
  (should already be, from Phase 1) before any multi-tenant production
  traffic.
- **Definition of done**: a second real facility can be onboarded through
  a real onboarding flow (brief §121) and its data is provably isolated
  from the first (the concurrency + cross-facility tests flagged as gaps
  in `docs/SECURITY_AUDIT.md` S-05 finally get a second tenant to run
  against).
