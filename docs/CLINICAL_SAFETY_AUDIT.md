# Clinical Safety Audit — Phase 0

This document inspects every place the codebase performs a "clinical
safety" check, states plainly what it does and doesn't guarantee, and
flags unsafe assumptions. **This repository is not clinically validated
software.** Nothing here should be read as, or represented to a hospital
as, a certified clinical decision-support system. This audit exists to
keep that distinction sharp as the system grows, per the explicit
instruction not to invent medical protocols or claim clinical validation.

## 1. What "safety check" means in this codebase today

There are exactly two real, code-enforced safety checks, both in
Hospital OS, both narrow by design:

### 1.1 Medication allergy conflict

**Location**: `src/lib/hospital/clinicalSafety.ts`,
`checkMedicationSafety()`.

**What it does**: string-matches the ordered drug's generic name against
the patient's `Allergy.substance` rows (case-insensitive substring match
in either direction). If a match is found, severity is `"danger"` when
the documented allergy severity is `"severe"`, else `"warning"`.

**What it does NOT do**:
- No cross-reactivity reasoning (e.g. a documented penicillin allergy does
  not flag a cephalosporin, despite known partial cross-reactivity in real
  clinical practice) — this would require a real drug-class reference
  database, which this system does not have and does not claim to have.
- No fuzzy/synonym matching beyond substring containment — "amoxicillin"
  vs. a patient allergy recorded as "amox" would match; "penicillin" vs.
  an allergy recorded as "PCN" would **not** match. Real-world allergy
  documentation is inconsistent; this check only catches what the
  substring logic catches.
- No severity grading beyond the two levels stored on `Allergy` — no
  distinction between a rash and anaphylaxis beyond the free-text
  `reaction` field, which nothing currently reads programmatically.

**What happens on a match**: the order is **blocked** (not created) if
the flag is `"danger"`-severity and no `overrideReason` was supplied. An
override reason unblocks it and is permanently persisted on the order
(`MedicationOrder.safetyFlags` + `overrideReason`) and logged
(`hospital.medication.ordered` audit event with `overridden: true`).
**A human always makes the final call; nothing in this pipeline can
silently proceed past a danger flag, and nothing can silently block a
clinician who has a real reason to proceed.** This is the correct shape
for a "software safety check that supports, not replaces, clinical
judgment" — verified live during Phase-0 testing of Hospital OS (blocked
without a reason, succeeded with one, both outcomes correctly logged).

### 1.2 Duplicate active medication

**Location**: same file, `checkMedicationSafety()`.

**What it does**: checks whether the patient already has another
`MedicationOrder` in `ORDERED`/`VERIFIED`/`DISPENSED` status with the same
generic name. Always `"warning"` severity (never blocks outright).

**What it does NOT do**: no dose-aggregation logic (e.g. two different
formulations of the same active ingredient at different doses would not
be recognized as a cumulative-dose risk beyond the same generic-name
match), no therapeutic-duplication detection across *different* drug
names that share a mechanism (e.g. two different NSAIDs).

### 1.3 Explicit non-goals (deliberately not built, not silently missing)

The following appear in the original brief's CDS wishlist (§20/§101) and
are **not implemented**, by design, because implementing them without a
real clinical reference dataset would mean fabricating medical logic:

- Full drug-drug interaction checking (needs a real interaction database —
  none is licensed/integrated).
- Renal/hepatic dose adjustment logic (needs weight-based/creatinine-based
  formulas tied to real nephrology/hepatology guidance — not built).
- Sepsis risk scoring, fall risk scoring, early-warning scores (NEWS2-style)
  — none implemented. Scholar's synthetic *teaching* cases reference these
  concepts in their reference answer keys (for grading a student's
  reasoning), but that is educational content, not a live scoring engine
  applied to Hospital OS patients.
- Pregnancy-category drug contraindication checking beyond what Scholar's
  RxLab does for *teaching cases only* (`src/lib/rxlab/validate.ts` —
  see §2 below; this validator is not wired into Hospital OS at all).

## 2. RxLab prescription validation (Scholar) — a different system, easily confused with Hospital OS's

**Location**: `src/lib/rxlab/validate.ts`.

**Important distinction**: this is Scholar's *educational simulator*,
watermarked "EDUCATIONAL SIMULATION — NOT A VALID PRESCRIPTION" on every
surface it appears. It performs allergy, duplicate-therapy, renal/hepatic-
caution (keyword-matched against a small hardcoded drug list —
`RENAL_CAUTION_DRUGS`, `HEPATIC_CAUTION_DRUGS`, `PREGNANCY_CAUTION_DRUGS`
in that file), and route/duration completeness checks — but explicitly
against a *case's* scripted `PrescriptionContext`, for grading a student's
reasoning against a reference answer, not against any real patient.

**Risk if confused with Hospital OS's clinicalSafety.ts**: none currently
— the two are not wired together, live in different modules
(`src/lib/rxlab/` vs `src/lib/hospital/`), and are called from
architecturally separate route trees (`/api/student/*` vs
`/api/hospital/*`). Flagging the distinction here explicitly because the
names/patterns are similar enough that a future engineer could mistakenly
believe RxLab's keyword lists ("caution drug" lists of ~5-10 hardcoded
generic names) constitute real clinical reference data suitable for
Hospital OS — **they do not**. They were authored as plausible-looking
teaching-case detail, not sourced from a pharmacology reference.

## 3. Bed state transitions

**Location**: `src/lib/hospital/bed.ts`.

**What it does**: enforces a fixed legal-transition table (e.g.
`AVAILABLE → OCCUPIED`, `OCCUPIED → CLEANING`, but not `AVAILABLE →
TRANSFER_PENDING`) inside a database transaction, so a bed cannot silently
skip states or be double-assigned under a race (see
`docs/SECURITY_AUDIT.md` — this is a data-integrity control, not a
clinical one, but it protects against the clinically-relevant failure
mode of two patients being assigned the same bed).

**Not a clinical safety check per se** — it protects operational
correctness (one bed, one patient, one state at a time), not clinical
appropriateness of the assignment (e.g. nothing checks that an isolation
patient is actually placed in an isolation-capable bed — `Bed.isolationRequired`
exists on the schema but **no route currently reads it to block or warn
on a mismatched assignment**). This is a real gap: the admission API
(`POST /api/hospital/admissions`) lets a doctor admit any patient to any
`AVAILABLE` bed regardless of isolation/gender-restriction flags.

## 4. Discharge readiness

**Location**: `src/lib/hospital/admission.ts`, `finalizeDischarge()`.

**What it does**: requires all six boolean readiness flags
(`clinicallyReady, documentationReady, billingReady, insuranceReady,
pharmacyReady, transportReady`) to be `true`, checked server-side inside
the finalize transaction, before the bed is released. Verified live:
finalize was correctly rejected with a list of missing flags before all
six were set, and succeeded (with a clinician's `signedByStaffId`
attached) once they were.

**What it does NOT do**: `clinicallyReady` is a boolean a `DOCTOR` sets —
**nothing validates that the underlying clinical picture actually
supports discharge** (e.g. no check against active critical alerts,
unacknowledged critical results, or abnormal recent vitals before allowing
`clinicallyReady = true`). This is intentional — that judgment belongs to
the clinician, and the software correctly does not attempt to
second-guess it — but it means the six flags are a **process checklist**,
not a clinical safety net. A doctor could set `clinicallyReady = true` for
a patient with an unacknowledged critical lab result sitting in the same
encounter, and the system would not stop them (though the Command Center
would still be showing that alert independently).

## 5. Critical result handling

**Location**: `src/lib/hospital/alertEngine.ts`,
`orders/lab/[id]/acknowledge`, `orders/imaging/[id]/verify`.

**What it does**: a lab/imaging result marked `isCritical: true` at entry
time stays flagged on the Command Center's alert feed, escalating from
`watch` to `critical` severity purely based on elapsed time, until an
explicit `DOCTOR` action clears it. Nothing auto-acknowledges. Verified
live end-to-end (troponin + CT finding both surfaced correctly, both
cleared correctly, only by explicit doctor action).

**What it does NOT do**:
- `isCritical` is set **by the person entering the result** (lab
  technician / radiology technician), a free judgment call with no
  reference-range-based auto-flagging. A critical potassium of 6.8 entered
  without the checkbox ticked would never appear on any alert feed. There
  is no numeric reference-range table anywhere in the schema to auto-
  detect this — `LabResult.referenceRange` is a free-text display string,
  not a structured `{low, high}` the system could compare `value` against.
- No paging/notification delivery — the alert only exists on the Command
  Center's page. A doctor not looking at that screen will not be notified.
  Brief §91's notification engine (SMS/email/push) is architecture-only,
  not built (see `docs/ENTERPRISE_HOSPITAL_ARCHITECTURE.md` §11).

## 6. Audit trails for clinical actions

**Verified present**: every clinical mutation (order placed, result
released, note signed, medication administered, discharge finalized, bed
state changed) writes an `AuditEvent` row with actor, timestamp, and a
JSON detail blob — confirmed by grep across all Hospital OS routes (every
route that mutates state calls `recordAuditEvent`). This is a genuine,
consistent pattern, not a gap.

**Not verified/gap**: no tamper-evidence on `AuditEvent` itself (no hash
chaining, no append-only DB constraint preventing an `UPDATE`/`DELETE` —
SQLite/Postgres would both permit a direct row edit with sufficient DB
access). Acceptable for Phase 1's threat model (the application layer
never edits these rows), a real gap before this data is relied on for
regulatory audit purposes.

## 7. Summary judgment

The two real safety checks that exist (allergy conflict, duplicate
medication) are implemented in the *correct shape* — transparent,
traceable to source data, blocking only on the higher-severity case,
always overridable by a human with a logged reason, never silently
auto-corrected or auto-approved by anything resembling AI. This shape
should be the template for every future safety check added (see
`docs/CLINICAL_SAFETY_AUDIT.md`'s companion,
`docs/HOSPITAL_THREAT_MODEL.md` T-04, for the security angle on the same
mechanism).

The gaps are gaps of **breadth** (no interaction database, no reference-
range auto-detection, no isolation/gender-bed-matching enforcement, no
notification delivery), not gaps of **soundness** — nothing found in this
audit fabricates a clinical judgment or presents a heuristic as validated
medical logic. Where the brief's wishlist items would require real
clinical reference data or licensed terminology this system does not
have, they were correctly left unbuilt rather than faked.
