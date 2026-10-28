# Importing a hospital's old HIMS

- **Status:** Designed (Flagship 1d, 2026-10-28); the open questions decided (2026-10-29, §10); phase 1 (CSV patients and encounters) to be built next.
- **What:** bringing a hospital's history from its previous system into Aarogya when it switches over: **patients, encounters, results and bills**, from **CSV exports, HL7 v2 messages or FHIR R4 bundles**.
- **The rule:** *refuse, don't guess.* A row that can't be mapped exactly is refused with a reason; it never becomes a best guess in a patient's record. Wrong-patient data is worse than missing data.
- **Builds on:** the staged FHIR import (`src/lib/hospital/interoperability/fhir/import.ts`: an external payload never reaches a clinical table; it is staged as MAPPED / CONFLICT / REJECTED and promoted only by a deliberate review), provenance (`interoperability/provenance.ts`), external identifiers (`externalIdentity.ts`), the patient duplicate and merge tools (`/api/hospital/patients/duplicates`, `merge`), the event spine, and the facility/Person split (`docs/ARCHITECTURE.md` §2).

## 1. Who and when

The hospital's IT lead and an Aarogya onboarding engineer run it during go-live, usually over a weekend, sometimes in waves (patients first, then the last two years of visits, then older history). Clinical leads review the mapping; finance signs off the opening balances. After go-live, the old system stays read-only for anything not imported.

## 2. What we import, and what we don't

| Class | Imported as | Not imported |
|---|---|---|
| **Patients** | `Patient` at the facility, with the old MRN kept as an external identifier (`LEGACY_MRN`, per source system) and a new UHID | A link to a `Person`: the old phone or email on file is **not** verification. People link their own record later through the normal verified flow (`docs/PERSON_IDENTITY_DESIGN.md`) |
| **Encounters** | `Encounter` (CLOSED, with the old dates, type, department, attending clinician where mappable) plus diagnoses | Open encounters: anyone currently admitted is admitted fresh in Aarogya at go-live, by the ward, with the old stay referenced |
| **Results** | Lab results (value, unit, reference range, flag, dates) as `LabOrder` + `LabResult` VERIFIED, imaging reports as text | Images (PACS stays where it is; a link if the PACS has one), instrument raw data |
| **Bills** | **Open balances only** (decided §10.1): one opening balance per patient from finance's signed list; historical invoices stay in the old system | Re-pricing, re-issuing, claims, closed historical invoices. Opening balances are hidden in the patient app until legal review (§10.6) |
| Medications | The last 12 months of prescriptions as historical `MedicationOrder` (COMPLETED), for the chart and allergy safety | Active inpatient orders: re-prescribed at go-live by the treating doctor (an imported order must never drive the MAR) |
| Allergies | `Allergy` entries, marked "imported, unverified" until a clinician confirms at the next visit | "No known allergies" (absence is not imported as a fact) |
| Notes, documents | Scanned documents and discharge summaries as attached documents with provenance, if the source has them | Free-text notes are imported only as documents, never parsed into structured data |

## 3. The pipeline

```
upload ──▶ parse ──▶ map ──▶ validate ──▶ DRY RUN report ──▶ mapping review ──▶ commit (batches) ──▶ reconcile
            │         │         │              │                    │                  │
         staging   source    refuse-       counts, samples,     clinical +        through the domain
         rows      profile   don't-guess   every refusal        finance sign-off  services, with events
```

1. **Upload.** Files go to the facility's own storage area, encrypted. Formats:
   - **CSV**, with a header row, one file per class;
   - **HL7 v2.x** message files (ADT A04/A08 for patients; ORU^R01 for results; DFT^P03 for charges, if the source sends them);
   - **FHIR R4** bundles (the existing parser).

   Every file is hashed. Uploading the same file twice is detected.
2. **Parse to staging.** Each row or message becomes an `ImportRow`: batch, class, source key (the source system's own id, e.g. its MRN or visit number), the raw text, the parsed fields and a status. Nothing touches a clinical table.
3. **Map, through a source profile** (`ImportProfile`, one per hospital and source system, versioned):
   - **column mapping:** which CSV column or HL7 field is which Aarogya field;
   - **declared formats:** date format (e.g. `DD/MM/YYYY`; there is no default), time zone, decimal separator, units per test;
   - **code maps:** the hospital's test codes to its Aarogya lab catalogue (LOINC where known), its diagnosis codes to ICD-10, departments, clinicians (to staff profiles or "legacy clinician" names kept as text), wards, payers;
   - **value maps:** sex codes, encounter types, result flags.

   The profile is data the engineer and the hospital edit in a mapping screen, never code. Every value with no mapping is listed, so it can be mapped or refused.
4. **Validate, refuse, don't guess** (§4).
5. **Dry run.** The whole batch is evaluated against the live database inside a transaction that is rolled back. The report shows:
   - counts per class: would create, would update, refused, needs review;
   - every refusal with its row and reason;
   - patient-match decisions;
   - unit conversions applied;
   - 20 random rows in full, before and after.

   It is a downloadable report for the hospital to check against the old system.
6. **Mapping review and sign-off.** A clinical lead reviews the code maps and a sample of results; finance reviews bills and balances. The sign-off (who, when, which profile version, which dry-run hash) is recorded. The commit refuses a batch whose data or profile changed after the dry run that was signed off.
7. **Commit in batches** of about 1,000 rows. Each row is created through the domain services in its own transaction, with its event (§6) and provenance (source system, file hash, row key, profile version). The source key is unique per batch class, so the commit is resumable and a re-run creates nothing twice.
8. **Reconcile.** After commit, the system recounts per class and per year against the source's own totals (patients, visits per year, results per year, invoice totals per year), and reports any difference.

## 4. Refuse, don't guess

A row is **refused**, with its reason, when:

| Field | Refused when |
|---|---|
| Dates | Missing where required; ambiguous under the profile's declared format (if no format is declared, every date is refused); before 1900 or in the future; a result before its own order |
| Patient match | No exact key (§5), or more than one candidate |
| Codes | A test, diagnosis, department or encounter type with no mapping (refused, not mapped to "other") |
| Units | A result whose unit isn't the catalogue's, and the profile has no explicit conversion for that test and unit pair |
| Values | A numeric test with a non-numeric value, unless the test is mapped as text; a value outside physical limits (e.g. haemoglobin 300 g/dL) |
| Duplicates | Two rows with the same source key and different content (both refused; same content: one kept) |
| Relations | A result whose order or visit is missing or refused; a visit whose patient is refused |
| Bills | Totals that don't add up (lines vs total, payments vs balance) |
| Identity documents | Any Aadhaar number, PAN or similar, which is **never imported** (the column is dropped at parse and the report says so) |

Refused rows stay in staging with their reason. The hospital can fix them at the source, or map the missing code, and re-run. Nothing refused is ever "imported anyway".

## 5. Patient identity

- **Exact keys only.** A legacy patient is the same as an existing Aarogya patient at this facility only through an exact key:
  - the same legacy MRN already imported (a re-run);
  - a verified ABHA on both, once ABDM is certified (pre-launch item 5);
  - a mapping the hospital supplies (old MRN to UHID).

  Name, date of birth and phone together are **candidates**, never a match. With no exact key, the legacy patient becomes a new patient.
- **Duplicates inside the source** (the same person under two MRNs, common in old HIMS) are reported as candidates. They are imported as two patients and resolved afterwards with the existing duplicate review and merge tools, by a person.
- **No Person links.** Imported patients have no Person. The link happens when the person proves they are that patient (a code to the record's phone, or in person).

## 6. Labels, events and the rest of the system

- **Labelled everywhere.** Imported rows carry provenance, and the chart, timeline and AI show "Imported from <old system>, <date>". They are facility records, but **not** "verified" in the product spec's sense: not signed or QR-checkable in Aarogya. The RAG index gets an `IMPORTED` origin label beside VERIFIED and PATIENT_PROVIDED, and the clinical advisor decides how the AI words it.
- **Events, without waking the live system.** Every created row emits its event in its transaction, but as **new import event types** (`LegacyPatientImported`, `LegacyEncounterImported`, `LegacyResultImported`, `LegacyBillImported`, plus `LegacyImportBatchCommitted` and `LegacyImportBatchReconciled`), not the live ones. That way the task generator, charge capture, claim drafting, the MAR scheduler and the person notifier never see a 2019 order as new work. Only the RAG indexer and the search projection subscribe. A gate checks that no live consumer reacts to an import.
- **No notifications to patients,** no SMS, no shares, no charges, no claims.
- **Retention.** Staging rows and uploaded files are deleted 30 days after reconcile sign-off (the report and provenance stay). Before that they are readable only by the facility's import role.
- **Undo.** Until the facility's go-live date, a committed batch can be retracted: every row it created is marked retracted and hidden, with its event. Nothing is deleted. After go-live, corrections are ordinary clinical amendments.

## 7. Data model (proposed, facility-scoped, additive)

- `ImportProfile`: facility, source system, version, mappings (JSON, validated), declared formats, createdBy, approvedBy.
- `ImportBatch`: facility, profile version, class, files (hashes), status (UPLOADED → PARSED → DRY_RUN → SIGNED_OFF → COMMITTING → COMMITTED → RECONCILED, or RETRACTED), dry-run hash, sign-offs, counts.
- `ImportRow`: batch, source key (unique per batch class), raw, parsed, status (STAGED, REFUSED with reason code, READY, CREATED with the target id, RETRACTED).
- `LegacyFinancialRecord`: facility, patient, document (the old invoice), totals, closing balance, source keys.
- A `LEGACY_MRN` external identifier system, with source system and value, unique per facility and source.

## 8. Gates (before the first hospital)

- `verify-postgres-legacy-import`:
  - a CSV, an HL7 and a FHIR batch go through dry run, sign-off, commit and reconcile;
  - each refusal rule has its own row that must be refused;
  - the dry run writes nothing;
  - changing the profile after sign-off blocks the commit;
  - a re-run creates nothing;
  - a retraction hides everything.
- `verify-postgres-legacy-import-isolation`:
  - imported events wake no live consumer (no task, charge, claim, MAR dose or notification);
  - an imported patient has no Person link;
  - another facility can't see a batch or its rows (404).
- **Perf:** 1,000,000 result rows parse and dry-run in under an hour on the staging database, and commit at a rate that fits a weekend.

## 9. Phases

1. CSV patients and encounters, the dry run and the report.
2. Results (CSV and HL7 ORU), unit rules, the clinical review.
3. FHIR bundles (reusing the staged import), medications and allergies.
4. Bills and opening balances with finance sign-off.
5. Retraction and the reconcile report.

## 10. Decisions (2026-10-29; were the open questions)

1. **How far back: 3 years of clinical data; bills as open balances only. Decided.** Older history stays in the old system (read-only), or comes in later as documents.
2. **Imported results show in trends, labelled "imported". Decided.** Units are converted only on an exact mapping in the profile (a test and unit pair); anything else is refused.
3. **Clinicians without Aarogya logins are kept as text names. Decided.** "Dr A Sharma (legacy)"; no inactive staff profiles are created.
4. **Formats: CSV first, then HL7 v2 ADT and ORU, then FHIR. Decided.**
5. **Per-patient notice under DPDP goes to the lawyer list. Decided.** Until the lawyers answer, no import into a live facility with real data; the real-data switch stays off.
6. **Opening balances are hidden in the patient app until legal review. Decided.**
7. **Patients admitted on cut-over night come in as active admissions, with a manual checklist. Decided.** A ward-by-ward checklist (bed, re-prescription by the treating doctor, allergies confirmed) closes each one; an imported order never drives the MAR.
8. **The hospital's medical records officer signs off the mapping. Decided.**
