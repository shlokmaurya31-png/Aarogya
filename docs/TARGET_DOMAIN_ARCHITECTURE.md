# Target Domain Architecture

Defines the target clinical domain model Aarogya should converge on. This
is forward-looking design, not a description of current code — see
`docs/DATA_MODEL_AUDIT.md` for what exists today and exactly how it
differs from this target.

## 1. Facility hierarchy (target)

```
Organization
  └─ Facility
       └─ Department
            └─ Ward
                 └─ Room          [MISSING TODAY — see §2]
                      └─ Bed
```

Current schema stops at `Ward → Bed` directly (no `Room`). Adding `Room`
is additive (a new model + a nullable `roomId` on `Bed`, backfillable) —
not a breaking change, sequenced into Phase 6 (Facilities) in
`docs/IMPLEMENTATION_ROADMAP.md` since nothing before that phase actually
needs room-level grouping (bed labels like `"EB-1"` are a sufficient
informal proxy until then).

## 2. Patient → Episode of Care → Encounter → Clinical Events (target)

```
Patient
  └─ Episode of Care                [MISSING TODAY]
       └─ Encounter (OPD / ED / IPD / Daycare / Telemedicine)
            ├─ Observation (Vital — EXISTS)
            ├─ Diagnosis / Problem   (Problem — EXISTS, free-text diagnosis)
            ├─ Allergy                (EXISTS, patient-level not encounter-level — correct, allergies outlive one encounter)
            ├─ Order                  (MedicationOrder / LabOrder / ImagingOrder — EXIST as 3 separate models)
            ├─ Result                 (LabResult / ImagingReport — EXIST)
            ├─ Medication / Administration (EXIST)
            ├─ Procedure               [MISSING TODAY]
            ├─ Note                    (ClinicalNote — EXISTS)
            ├─ Referral                 [MISSING TODAY]
            ├─ Care Plan                 [MISSING TODAY]
            ├─ Task                       [MISSING TODAY as a first-class entity — see §5]
            └─ Discharge               (EXISTS, 1:1 with Admission, not general to every encounter type)
```

### 2.1 Episode of Care — why it's needed and why it wasn't built yet

An `EpisodeOfCare` groups related encounters around one clinical problem
(e.g. a patient's OPD visit for chest pain → same-day ED escalation →
IPD admission → follow-up OPD visit, all for the same cardiac event).
Today, each of those is an independent `Encounter` with no link between
them beyond sharing `patientId`. This means:

- Billing cannot currently consolidate charges across that journey into
  one statement (`Bill.encounterId` is unique — one bill per encounter,
  see `docs/DATA_MODEL_AUDIT.md` §6).
- There's no query answering "show me everything related to this one
  clinical episode," only "show me everything for this patient, ever" (the
  chart API) or "show me this one encounter."

**Not built this phase** because no current workflow (Admission/Discharge/
Billing as they exist today) actually needs episode grouping to function
correctly — it's a real gap for the *revenue cycle* and *care
coordination* phases specifically (Phase 5 and Phase 3 referral work in
the roadmap), not a blocker for anything already shipped.

### 2.2 Procedure, Referral, Care Plan — deliberately not modeled yet

These correspond to real brief-requested capabilities (OT/surgery,
referral management, nursing care plans) that have no working workflow
behind them yet. Modeling the entities without the workflow would be
exactly the "architecture theater" this audit is supposed to prevent —
per the data-model audit's own principle (§9 of `DATA_MODEL_AUDIT.md`),
an unused table is not better than an honestly-absent one. These belong
to Phase 3 (Care Plan, as part of Nursing) and Phase 6 (Procedure, as part
of OT) in the roadmap, added when their real workflow is built alongside
them.

### 2.3 Task — the one entity worth pulling forward

Nursing "tasks" (medications due, vitals due) currently exist only as
**computed views** over `MedicationAdministration`/`Vital` rows (the
Nursing task engine, `/api/hospital/nurse/tasks`, queries live data rather
than reading from a `Task` table). This works today because the only two
task types are medication administration and vitals recording, both of
which already have a natural home table. It stops working once task
types multiply (wound care, patient education, fall-precaution checks,
discharge-prep tasks — brief §23's full list) that don't have their own
natural backing table. **Recommendation**: introduce a generic `Task`
entity (owner, type, dueAt, status, entityType/entityId polymorphic
reference) in Phase 3 alongside Nursing depth, rather than continuing to
special-case each new task type as another computed-view query.

## 3. Terminology binding (target, not built)

`Problem.diagnosis`, `Allergy.substance`, and every drug/test/study
"name" field in the schema are free text today (see
`docs/DATA_MODEL_AUDIT.md` §4, §5). The target state binds these to real
coding systems:

- Diagnoses → ICD-10/11 or SNOMED CT concept references.
- Lab tests → LOINC codes.
- Medications → RxNorm or a licensed local (Indian) drug dictionary.
- Imaging studies → DICOM modality/procedure codes.

**Not implemented, and correctly not faked** — none of these are licensed
or integrated. The schema should grow a `code`/`codeSystem` pair of
nullable columns alongside each free-text field (additive, non-breaking)
once a real terminology source is selected, rather than inventing a fake
code system now. See `docs/CORE_PLATFORM_ARCHITECTURE.md` and the
original brief's interoperability sections — this is Phase 9 work.

## 4. Identity model (target)

`Patient.uhid` is correctly the internal, facility-scoped identifier
today. The target model treats external identifiers (ABHA, insurance
member ID, a legacy system's MRN) as *additional* identifiers on the same
patient via `PatientIdentifier` (already modeled, see
`docs/DATA_MODEL_AUDIT.md` §4) — never as a replacement for `uhid`. This
matches the brief's explicit instruction (§70) that ABHA is a linking/
authentication mechanism, not the hospital's own primary key. No change
needed to reach this target beyond what's already modeled; the gap is
that no ABHA integration exists to actually populate `PatientIdentifier`
rows of that type (Phase 9).

### 4.1 Cross-facility patient identity — the one real target-vs-current gap

Today, `Patient.facilityId` is required and singular — the same real
person seen at two facilities in the same `Organization` becomes two
unrelated `Patient` rows. The target model needs an organization-level
"master patient index" concept linking facility-local `Patient` records
that represent the same person, **without** collapsing them into one row
(each facility's clinical record should remain that facility's own
record, per real-world data-governance norms, even within one hospital
group). This is explicitly a Phase 10 (multi-facility) concern, not
addressed by a schema change alone — it needs a governance decision about
what a hospital group is allowed to share across its own facilities,
which is a policy question before it's an engineering one.

## 5. Summary of concrete, additive schema changes implied by this document

None of the following are breaking changes to the current schema — all
are new models or nullable columns, sequenced into the roadmap phase
where their workflow is actually built:

| Addition | Phase | Reason not built now |
|---|---|---|
| `Room` model between `Ward` and `Bed` | 6 | No workflow needs room-level grouping yet |
| `EpisodeOfCare` model | 5 (billing consolidation), 3 (care coordination) | No current workflow needs cross-encounter grouping |
| `Procedure` model | 6 (OT) | No OT workflow exists yet |
| `Referral` model | 3 (Nursing/Doctor coordination) | No referral workflow exists yet |
| `CarePlan` model | 3 (Nursing) | No care-plan workflow exists yet |
| Generic `Task` model | 3 (Nursing depth) | Current 2 task types don't need it yet; will before a 3rd is added |
| `code`/`codeSystem` columns on diagnosis/drug/test/study fields | 9 (Interoperability) | No terminology source integrated yet |
| Organization-level master patient index | 10 (Multi-facility) | Governance decision precedes the schema change |
