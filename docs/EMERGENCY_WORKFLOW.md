# Emergency Department Workflow — Phase 2

## Arrival

An ED encounter can originate from walk-in, ambulance, referral,
transfer, or OPD escalation (`Encounter.accessSource`, brief §17).
Ambulance arrivals additionally capture `arrivalMode`, `ambulanceRef`,
and `traumaIndicator` (brief §18/§47) — data-capture fields only; no live
ambulance dispatch integration exists or is claimed.

## Triage

`POST /api/hospital/encounters/[id]/triage` (permission `triage:record`,
granted to `DOCTOR` and `NURSE`) records a `TriageAssessment`: acuity
1–5, chief complaint, red flags, assigned area, notes. **The
clinician/nurse decides the acuity — the software never determines it
autonomously** (brief §19's explicit instruction). Recording triage also:

1. Updates `Encounter.triageLevel` (the denormalized cache existing
   order-routing code already reads) and advances the encounter to
   `TRIAGED` when legal.
2. Recomputes the patient's `QueueEntry.priorityScore` if they have an
   active queue entry, with `priorityReason` recording that the change
   came from a recorded triage acuity — never a silent reorder (brief
   §23).

Re-triage is supported (multiple `TriageAssessment` rows per encounter,
most recent wins for board/queue purposes) — vital for a patient whose
condition changes while waiting.

## ED states

Rather than overloading `EncounterStatus` with every operational detail
(brief §22's explicit instruction), operational ED state is tracked
across two existing-shape mechanisms instead of a new status enum:

- **`TriageAssessment.assignedArea`** (`RESUSCITATION` / `HIGH_PRIORITY` /
  `STANDARD` / `OBSERVATION`) — which ED board column a patient is in.
- **`QueueEntry.status`** (`WAITING`/`CALLED`/`IN_SERVICE`/...) — whether
  they're waiting for or with a doctor right now.
- **`EncounterLocation`** — physical placement (a real `Bed` in the
  Emergency ward, or a free-text `areaLabel` like "CT (temporary)").

An ED encounter with no `TriageAssessment` yet shows in the board's
`TRIAGE_PENDING` column — the brief's `WAITING_TRIAGE`-equivalent state,
derived rather than stored.

## ED board

`GET /api/hospital/ed-board` (`src/components/hospital-os/EdBoard.tsx`)
— every card is a live query: patient, UHID, arrival/wait time, triage
acuity, current location, attending doctor, pending lab/imaging order
counts, and whether an admission request is pending for them. The UI
polls every 20s (`setInterval`, not a full-page reload) — a deliberate,
minimal real-time-enough mechanism per brief §55's explicit "do not
introduce a huge new infrastructure stack" instruction; no WebSocket/SSE
layer was built.

Live-verified this phase: triaging a `TRIAGE_PENDING` patient moves them
to the correct column on the next board load.

## Resuscitation / critical area

Modeled as `TriageAssessment.assignedArea === "RESUSCITATION"` plus an
`EncounterLocation` pointing at a real `Bed` in the Emergency ward when
one is assigned. No separate "responsible team"/escalation-chain entity
was built — deliberately narrow, matching brief §24's explicit "do NOT
build a full ICU system yet."

## ED consultation and disposition

Reuses the existing Phase 0/1 Doctor Workspace unchanged (brief §25's
explicit instruction) — assessment, vitals review, diagnosis, orders,
clinical notes, and referrals for a specialist consult (Phase 1's
`Referral` model already implements "requested → accepted → in progress
→ completed," satisfying brief §27 without a new model — see
`docs/CLINICAL_CORE.md` §5). Disposition from ED follows the same paths
as OPD (`docs/OPD_WORKFLOW.md`), with admission requests being the most
common ED-specific path.

## Emergency priority

`computeQueuePriority()` (see `docs/PATIENT_FLOW.md` §4) gives ED/
emergency-access encounters a large score reduction and lets a recorded
triage acuity dominate entirely — but the reason is always recorded in
`QueueEntry.priorityReason`, satisfying brief §23's "the system should
record why priority changed."

## What's not built this phase

Real-time push beyond 20s polling; a formal specialist-paging/escalation
workflow beyond `Referral`; ambulance pre-arrival notification (a data
field exists, no live feed); a dedicated observation-outcome state
machine (`ADMIT`/`DISCHARGE`/`TRANSFER`/`CONTINUE_OBSERVATION` — these
are reachable through the existing admission-request/discharge/transfer
routes, just not wrapped in one "observation outcome" UI/endpoint).
