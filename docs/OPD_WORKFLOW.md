# OPD Workflow — Phase 2

## Flow

```
Appointment (or walk-in)
  → Arrival / Check-in           POST /api/hospital/appointments/[id]  {action:"checkIn"}
  → Waiting (REGISTRATION queue) POST /api/hospital/queue              {queueType:"REGISTRATION"}
  → Vitals                       POST /api/hospital/encounters/[id]/vitals   (Phase 0, reused as-is)
  → Doctor queue (OPD_DOCTOR)    POST /api/hospital/queue              {queueType:"OPD_DOCTOR"}
  → Consultation                 PATCH /api/hospital/queue/[id]        {action:"start"} / {action:"complete"}
  → Orders / Diagnosis / Rx      Phase 0/1 Doctor Workspace, unchanged
  → Disposition                  see below
  → Completion                   Encounter closed, or continues to admission/transfer/ED
```

Configurable — not every visit passes through every step (a walk-in
skips the appointment step; a doctor can start a consultation without a
prior formal "call"; vitals are optional for a quick follow-up).

## Check-in — never a duplicate encounter

`checkInAppointment()` (`src/lib/hospital/appointment.ts`) locates the
appointment, verifies it isn't already cancelled/no-show/completed, and
either reuses `Appointment.encounterId` if a check-in already happened
for this visit, or creates exactly one new `Encounter` (type `OPD`,
`accessSource` copied from the appointment's `source`) and links it —
satisfying brief §12's explicit "do not create duplicate encounters if
the patient already has an active encounter for the same visit."

## Doctor queue

`src/components/hospital-os/DoctorWorkspace.tsx`'s "My queue" panel
(new this phase) shows a doctor's own `OPD_DOCTOR`- and `ED`-type
`QueueEntry` rows, priority-sorted (`src/lib/hospital/queue.ts`'s
`computeQueuePriority()` — see `docs/PATIENT_FLOW.md` §4), with
Call next / Start / Complete actions. "Call next" (`POST
/api/hospital/queue/next`) always picks the lowest-`priorityScore`,
then longest-waiting entry for that doctor — never a manual reorder
without a recorded `priorityReason`.

## Consultation state

Starting service (`{action:"start"}`) sets `QueueEntry.startedAt`;
completing (`{action:"complete"}`) sets `completedAt` and flips status
to `COMPLETED`. This is deliberately a `QueueEntry`-level state, separate
from `Encounter.status` — the encounter's own clinical state
(`IN_CONSULTATION`, etc.) continues to be driven by the existing Phase 1
`encounterStateMachine.ts`, not duplicated here.

## Disposition

After consultation, the existing Phase 0/1 routes already cover every
disposition path the brief names:

| Disposition | Route (existing, unchanged) |
|---|---|
| Continue outpatient / prescription / follow-up | `POST /api/hospital/orders/medication`, encounter stays `OPD` |
| Investigations | `POST /api/hospital/orders/{lab,imaging}` |
| Admission | **New this phase**: `POST /api/hospital/admission-requests` — see `docs/ADT_ARCHITECTURE.md` §1 |
| Referral / specialist consult | `POST /api/hospital/referrals` (Phase 1) |
| Emergency escalation | Register a new `ED`-type encounter, or (future) convert in place — not built this phase, see REMAINING GAPS |
| Discharge / completion | `transitionEncounter()` to `DISCHARGED`/`CLOSED` (Phase 1) |

Phase 2 did not build a single unified "disposition picker" UI screen —
each disposition uses its own existing or newly-built endpoint. A
consolidated disposition UI is a reasonable Phase 3 UI-polish item, not a
missing backend capability.

## No-show and cancellation

`markNoShow()` only accepts appointments still in `REQUESTED`/
`CONFIRMED`/`RESCHEDULED` — an already-checked-in or completed
appointment cannot be retroactively marked no-show.
`cancelAppointment()` requires a reason and records who cancelled and
when; never a silent delete (brief §43). Both live-verified this phase.
