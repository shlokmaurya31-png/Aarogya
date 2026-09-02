# Master Gap Matrix

Every capability identified across this Phase 0 audit, in one table.
"Existing"/"Partial"/"Missing" are mutually exclusive per row (a
capability is classified once, at its most accurate status — module-level
summaries in `docs/MODULE_BOUNDARIES.md` sometimes span multiple rows
here for capabilities within one module at different maturity levels).
Priority reflects dependency order and business value, not effort.

| Capability | Existing | Partial | Missing | Dependency | Phase | Priority |
|---|:-:|:-:|:-:|---|:-:|:-:|
| Password auth + signed sessions | ✅ | | | — | done | — |
| Session revocation | | | ✅ | Identity Core | 1 | High |
| Login rate limiting | | | ✅ | Identity Core | 1 | High |
| RBAC / permission table | ✅ | | | Identity Core | done | — |
| Facility tenant scoping | ✅ | | | Identity Core | done | — |
| Cross-facility isolation (tested, 2+ tenants) | | ✅ | | Tenant Core | 10 | Medium |
| Patient self-service accounts (real) | | | ✅ | Identity Core | 1 | Critical |
| Unified single clinical backend (retire prototype's Zustand data) | | | ✅ | Clinical Core | 1 | Critical |
| Patient registration (staff-entered) | ✅ | | | Patient Admin | done | — |
| Patient self-registration | | | ✅ | Patient Admin | 1 | High |
| Patient identifier linkage (ABHA etc.) | | ✅ (modeled, unpopulated) | | Patient Admin | 9 | Medium |
| Patient merge/dedup | | | ✅ | Patient Admin | later | Low |
| Appointment scheduling | | | ✅ | Scheduling | 2 | High |
| Queue/token management | | | ✅ | Scheduling | 2 | Medium |
| OPD registration/consultation | ✅ (via generic Encounter) | | | Emergency/OPD | done | — |
| ED triage (structured) | ✅ | | | Emergency | done | — |
| ED-specific board/metrics | | | ✅ | Emergency | 2 | Medium |
| Admission (bed assignment, transactional) | ✅ | | | Admissions | done | — |
| Transfer | ✅ | | | Admissions | done | — |
| Discharge (readiness flags, sign-off) | ✅ | | | Admissions | done | — |
| Discharge clinical-validity cross-check (vs. active alerts) | | | ✅ | Admissions + Clinical Safety | 7 | Medium |
| Bed state machine + audit trail | ✅ | | | Operational Core | done | — |
| Isolation/gender bed-matching enforcement | | | ✅ | Operational Core + Clinical Safety | 7 | Medium |
| Room entity (Ward → Room → Bed) | | | ✅ | Operational Core | 6 | Low |
| Longitudinal clinical record (chart API) | ✅ | | | Clinical EMR | done | — |
| Clinical note signing + amendment (never-mutate) | ✅ | | | Clinical EMR | done | — |
| Problem list | ✅ (free-text) | | | Clinical EMR | done | — |
| Terminology binding (ICD/SNOMED/LOINC/RxNorm) | | | ✅ | Clinical EMR | 9 | Medium |
| Procedure tracking | | | ✅ | Clinical EMR / OT | 6 | Medium |
| Referral management | | | ✅ | Clinical EMR / Nursing | 3 | Medium |
| Care plan | | | ✅ | Nursing | 3 | Medium |
| Vitals recording | ✅ | | | Clinical EMR | done | — |
| Allergy documentation | ✅ | | | Clinical EMR | done | — |
| Medication ordering | ✅ | | | Medication | done | — |
| Allergy-conflict safety check | ✅ | | | Clinical Safety | done | — |
| Duplicate-medication safety check | ✅ | | | Clinical Safety | done | — |
| Drug-drug interaction checking | | | ✅ (needs real reference data) | Clinical Safety | 9+ | Medium |
| Renal/hepatic dose-adjustment logic | | | ✅ (needs real reference data) | Clinical Safety | 9+ | Low |
| Medication administration record | ✅ | | | Nursing | done | — |
| MAR auto-transition DUE → MISSED | | ✅ (computed at read time, not stored) | | Nursing | 3 | Low |
| Nursing task engine (medications, vitals) | ✅ | | | Nursing | done | — |
| Generic Task entity (all task types) | | | ✅ | Nursing | 3 | Medium |
| Nursing handover (SBAR) | | | ✅ | Nursing | 3 | Medium |
| Pharmacy dispensing/verification | | | ✅ | Pharmacy | 3 | High |
| Pharmacy inventory | | | ✅ | Pharmacy / Inventory | 6 | Medium |
| Lab order → result | ✅ | | | Laboratory | done | — |
| Lab sample collection/accession/rejection tracking | | | ✅ | Laboratory | 4 | Medium |
| Structured reference ranges (auto-critical detection) | | | ✅ | Laboratory + Clinical Safety | 4 | High |
| Critical-result acknowledgement workflow | ✅ | | | Laboratory/Radiology | done | — |
| Imaging order → report | ✅ | | | Radiology | done | — |
| PACS/DICOM adapter | | | ✅ (architecture only, correctly) | Radiology | 9 | Low |
| Blood bank (inventory, crossmatch, transfusion) | | | ✅ | Blood Bank | 6 | Medium |
| ICU flowsheets / ventilator parameters | | | ✅ | ICU | 6 | Medium |
| OT scheduling / pre-op / operative note | | | ✅ | OT | 6 | Medium |
| Billing charge engine | ✅ | | | Billing | done | — |
| Payment recording | | | ✅ | Billing | 5 | Critical |
| Decimal money (not Float) | | | ✅ | Billing | 5 | High |
| Insurance policy / claim lifecycle | | | ✅ | Insurance | 5 | High |
| Episode of Care (cross-encounter grouping) | | | ✅ | Billing + Clinical EMR | 5/3 | Medium |
| Packages/discounts | | | ✅ | Billing | later | Low |
| Inventory (general, non-pharmacy) | | | ✅ | Inventory | 6 | Medium |
| Procurement workflow | | | ✅ | Procurement | 6 | Low |
| Workforce credentialing alerts | | ✅ (fields exist, unread) | | Workforce | 6 | Low |
| Staff rostering/shifts | | | ✅ | Workforce | 6 | Medium |
| Quality/incident reporting + CAPA | | | ✅ | Quality | 7 | Medium |
| Infection control (isolation enforcement, trend tracking) | | | ✅ | Infection Control | 7 | Medium |
| Medical records completeness tracking | | | ✅ | Medical Records | 7 | Low |
| Facilities/biomedical equipment tracking | | | ✅ | Facilities | 6 | Low |
| Patient experience (feedback/NPS) | | | ✅ | Patient Experience | later | Low |
| Command Center live snapshot + alerts | ✅ | | | Intelligence | done | — |
| Historical analytics / drill-down | | | ✅ | Intelligence | 8 | Medium |
| Event bus / outbox | | | ✅ (architecture only, correctly deferred) | Intelligence | 8 | Low (until a real consumer exists) |
| AI copilot — Scholar (viva/tutor) | ✅ | | | AI | done | — |
| AI copilot — Hospital OS (clinical/ops) | | | ✅ | AI | 9 | Low |
| FHIR/HL7 adapters | | | ✅ (architecture only) | Interoperability | 9 | Low |
| ABDM/ABHA integration | | | ✅ | Interoperability | 9 | Medium |
| Scholar case engine + scoring | ✅ | | | Scholar | done | — |
| Scholar full case-authoring wizard | | ✅ | | Scholar | later | Low |
| Teaching-hospital integration (Scholar ↔ Hospital OS) | | | ✅ | Interoperability + Scholar | 9 | Low |
| Multi-facility SaaS billing/licensing | | | ✅ | Enterprise | 10 | Low (until 2nd customer) |
| Postgres cutover | | | ✅ | Database | 10 (or earlier if forced) | High once real traffic exists |
| Rate limiting + session revocation (repeat — production blockers) | | | ✅ | Identity Core | 1 | Critical |

## Top-priority reading of this matrix

The **Critical**-priority rows are the true blockers, in dependency order:
1. Unify the clinical backend (retire the prototype's Zustand-only data) —
   everything else compounds the duplication problem until this happens.
2. Patient self-service accounts — the precondition for #1 to matter.
3. Payment recording — `Bill.paidAmount` being permanently zero is the
   single most "beautiful UI, no real system" gap left in an otherwise
   solid Financial Core, and billing without payments isn't billing.
4. Rate limiting + session revocation — both CRITICAL/HIGH in
   `docs/SECURITY_AUDIT.md`, both cheap relative to their risk, both
   explicitly scheduled for Phase 1 rather than deferred further.
