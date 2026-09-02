# Module Boundaries

Target module decomposition for Aarogya Hospital OS, with current
implementation status honestly marked per module. Permissions reference
`src/lib/auth/permissions.ts`'s existing strings where they exist, and
propose new ones (marked *proposed*) where a module has no code yet.

Status legend matches `docs/IMPLEMENTATION_INVENTORY.md`:
IMPLEMENTED / PARTIAL / ARCHITECTURE ONLY / MISSING.

---

### 1. Patient Administration — **PARTIAL**
- Responsibilities: patient registration, identity/identifiers, demographics.
- DB ownership: `Patient`, `PatientIdentifier`.
- APIs: `/api/hospital/patients` (GET/POST).
- Events (future): `PATIENT_REGISTERED`, `PATIENT_IDENTIFIER_LINKED`.
- Depends on: Tenant Core.
- Permissions: `patient:read`, `patient:write` (exist).
- Gap: no patient merge/duplicate-detection (brief §158), no demographic
  update route (only create exists).

### 2. Scheduling — **MISSING**
- Responsibilities: appointment booking, rescheduling, waitlists, queues.
- DB ownership: none today (no `Appointment` model in Hospital OS's
  schema — the original prototype's `Appointment` interface is
  client-only, see `docs/IMPLEMENTATION_INVENTORY.md` §1).
- Events (future): `APPOINTMENT_CREATED`, `APPOINTMENT_CANCELLED`.
- Depends on: Patient Administration, Clinical EMR (for provider
  availability).
- Permissions: *proposed* `appointment:create`, `appointment:manage`.

### 3. Emergency — **PARTIAL**
- Responsibilities: ED registration, triage, disposition.
- DB ownership: `Encounter` (`type: ED`), `triageLevel` field.
- APIs: `/api/hospital/encounters` (create with `type: ED`),
  `/api/hospital/encounters/[id]` (triage PATCH).
- Depends on: Patient Administration, Clinical EMR.
- Permissions: `encounter:create`, `encounter:triage` (exist).
- Gap: no dedicated ED board/view distinct from the generic Doctor
  Workspace encounter list, no door-to-X timing metrics (brief §12), no
  Code Blue/resuscitation workflow.

### 4. Admissions — **IMPLEMENTED**
- Responsibilities: admit, transfer, discharge, bed assignment.
- DB ownership: `Admission`, `Transfer`, `Discharge`, `Bed`, `BedStateEvent`.
- APIs: `/api/hospital/admissions/*`, `/api/hospital/beds/*`.
- Events (future): `BED_RESERVED`, `BED_OCCUPIED`, `DISCHARGE_REQUESTED`,
  `DISCHARGE_BLOCKED`, `DISCHARGE_COMPLETED`.
- Depends on: Patient Administration, Operational Core (beds).
- Permissions: `admission:create`, `admission:transfer`,
  `admission:discharge:initiate`, `admission:discharge:finalize`,
  `bed:manage` (all exist).
- This is the most complete module in the repository — transactional,
  audited, unit-tested state machine.

### 5. Clinical EMR — **IMPLEMENTED (core), PARTIAL (breadth)**
- Responsibilities: longitudinal record, notes, problems, allergies, vitals.
- DB ownership: `ClinicalNote`, `Problem`, `Allergy`, `Vital`.
- APIs: `/api/hospital/patients/[id]/chart`,
  `/api/hospital/encounters/[id]/{notes,vitals}`.
- Depends on: Patient Administration.
- Permissions: `clinical:note:create`, `clinical:note:sign`,
  `vital:record` (exist).
- Gap: no `Procedure`/`Referral`/`CarePlan` (see
  `docs/TARGET_DOMAIN_ARCHITECTURE.md`), no terminology binding.

### 6. Doctor Workspace — **IMPLEMENTED**
- Responsibilities: patient list, patient chart UI, order entry UI.
- DB ownership: none (consumes Clinical EMR + Orders modules).
- UI: `src/components/hospital-os/{DoctorWorkspace,PatientChart}.tsx`.
- Depends on: Clinical EMR, Orders, Admissions.
- Permissions: composite of the above.

### 7. Nursing — **PARTIAL**
- Responsibilities: task engine, medication administration, handover.
- DB ownership: `MedicationAdministration` (task source), `Vital` (task
  source). No generic `Task` entity (see
  `docs/TARGET_DOMAIN_ARCHITECTURE.md` §2.3).
- APIs: `/api/hospital/nurse/tasks`,
  `/api/hospital/orders/medication/[id]/administer`.
- Depends on: Orders (Medication), Admissions.
- Permissions: `medication:administer`, `vital:record` (exist).
- Gap: no digital shift handover (brief §24), no SBAR format, no
  wound-care/fall-precaution/patient-education task types.

### 8. Medication (Orders) — **IMPLEMENTED (narrow)**
- Responsibilities: prescribing, safety checks, order lifecycle.
- DB ownership: `MedicationOrder`.
- APIs: `/api/hospital/orders/medication`.
- Depends on: Clinical EMR (Allergy), Clinical Safety (cross-cutting, see
  `docs/CLINICAL_SAFETY_AUDIT.md`).
- Permissions: `clinical:order:medication` (exists).

### 9. Pharmacy — **MISSING** (Hospital OS side); Scholar has a fully
   separate *educational* RxLab, not to be confused (see
   `docs/CLINICAL_SAFETY_AUDIT.md` §2).
- Responsibilities: dispensing, inventory, verification.
- DB ownership: none today. `PHARMACIST` role and
  `medication:verify` permission exist but no route uses them yet.
- Depends on: Medication (Orders), Inventory.

### 10. Laboratory — **IMPLEMENTED (narrow)**
- Responsibilities: order → collect → result → release → acknowledge.
- DB ownership: `LabOrder`, `LabResult`.
- APIs: `/api/hospital/orders/lab/*`.
- Permissions: `clinical:order:lab`, `lab:result:enter`,
  `lab:result:release`, `lab:result:acknowledge` (exist).
- Gap: no sample-collection/accession/rejection tracking (brief §27's
  full workflow), no reference-range-based auto-critical-detection (see
  `docs/CLINICAL_SAFETY_AUDIT.md` §5).

### 11. Radiology — **IMPLEMENTED (narrow)**
- Same shape as Laboratory. DB ownership: `ImagingOrder`, `ImagingReport`.
- Permissions: `clinical:order:imaging`, `imaging:report:enter`,
  `imaging:report:verify` (exist).
- Gap: no PACS/DICOM adapter (architecture-only, brief §28).

### 12. ICU — **MISSING**
- No flowsheet, ventilator-parameter, or sedation-scale entities exist.
  `WardType.ICU` exists as a ward classification only.

### 13. OT (Surgery) — **MISSING**
- No `Procedure`, no OT scheduling, no pre-op checklist entity.

### 14. Blood Bank — **MISSING**

### 15. Billing — **PARTIAL**
- Responsibilities: charge capture, bill generation.
- DB ownership: `Charge`, `Bill`.
- APIs: `/api/hospital/billing/[encounterId]`.
- Permissions: `billing:view`, `billing:charge:create` (exist).
- Gap: no payment recording (`Bill.paidAmount` unused), no packages/
  discounts, `Float` not `Decimal` (see `docs/DATABASE_PRODUCTION_READINESS.md`).

### 16. Insurance — **MISSING**
- No `InsurancePolicy`/`Claim` model in Hospital OS (original prototype's
  `InsuranceClaim` is client-only mock data, unrelated).

### 17. Inventory — **MISSING**

### 18. Procurement — **MISSING**

### 19. Workforce (HR/Rostering) — **PARTIAL**
- `HospitalStaffProfile` covers identity/credential fields
  (`licenseNumber`, `licenseExpiry`) but nothing reads them; no rostering/
  shift/leave model at all.

### 20. Quality — **MISSING**

### 21. Infection Control — **MISSING**
- `Bed.isolationRequired` exists but is not enforced anywhere (see
  `docs/CLINICAL_SAFETY_AUDIT.md` §3) — the one piece of infection-
  control-relevant data that exists today, unused.

### 22. Medical Records — **MISSING** (as a distinct module; document
   completeness/amendment concepts exist informally via `ClinicalNote.status`).

### 23. Facilities — **MISSING** (beyond the `Ward`/`Bed` hierarchy
   itself, which belongs to Admissions/Operational Core, not a separate
   Facilities-maintenance module).

### 24. Patient Experience — **MISSING**

### 25. Analytics — **MISSING** (see `docs/CORE_PLATFORM_ARCHITECTURE.md`
   — Command Center gives current-state snapshots, not trend analytics).

### 26. AI — **PARTIAL** (Scholar only, see `docs/CORE_PLATFORM_ARCHITECTURE.md`;
   zero AI for the Hospital OS domain).

### 27. Interoperability — **ARCHITECTURE ONLY** (Scholar's
   `ClinicalCaseProvider` pattern is the template; nothing built for
   FHIR/HL7/DICOM/ABDM in either system).

### 28. Scholar — **IMPLEMENTED** (own full module, see
   `docs/STUDENT_PLATFORM_ARCHITECTURE.md`). Explicitly **not** a
   dependency of any hospital-domain module and vice versa — the only
   connection point is the shared `User`/`Role`/`AuditEvent`/session
   infrastructure (Identity Core), by design, per the privacy boundary in
   `docs/CLINICAL_EDUCATION_PRIVACY.md`.
