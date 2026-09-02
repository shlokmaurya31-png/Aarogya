# ADT Architecture — Admission, Discharge, Transfer (Phase 2)

The request/reservation layer built on top of Phase 0's existing
`Admission`/`Transfer`/`Discharge`/`Bed` machinery. See
`docs/PATIENT_FLOW.md` §1 for why nothing here duplicates that machinery.

## 1. Admission

### States

```
AdmissionRequest.status:
  PENDING ⇄ DEFERRED → BED_RESERVED → ADMITTED (terminal)
  PENDING/DEFERRED → REJECTED (terminal)
  PENDING/DEFERRED/BED_RESERVED → CANCELLED (terminal)
  BED_RESERVED → PENDING (releaseReservation — "change destination")
```

### Flow

1. **Request** (`POST /api/hospital/admission-requests`, permission
   `admission:request`) — a doctor/nurse creates a request from an active
   encounter. Does **not** touch `Bed` or create an `Admission` row
   (brief §28's explicit instruction).
2. **Bed matching** (`GET /api/hospital/admission-requests/[id]/eligible-beds`,
   permission `admission:allocate`) — `src/lib/hospital/bed.ts`'s
   `findEligibleBeds()` returns a ranked list filtered by facility, ward
   type (exact match first, then any), isolation requirement, and gender
   compatibility. Never auto-picks "the first available bed" — a human
   chooses from the list.
3. **Allocate** (`PATCH .../[id]` `{action:"allocate", bedId}`) —
   atomically reserves the chosen bed (`transitionBed(bedId, RESERVED,
   ..., tx)`) and marks the request `BED_RESERVED`, in one
   `$transaction`. If either half fails, neither commits.
4. **Confirm** (`PATCH .../[id]` `{action:"confirm"}`) — calls the
   existing `admitPatient()` with the reserved bed (relaxed to accept
   `RESERVED` as a legal starting bed status, see
   `docs/PATIENT_FLOW.md` §1), which creates the real `Admission` row,
   flips the bed to `OCCUPIED`, and transitions the encounter to
   `ADMITTED` — all inside `admitPatient()`'s own existing transaction.
   The request is then linked via `AdmissionRequest.admissionId`.
5. **Reject** (`{action:"reject", reason}`, permission `admission:approve`)
   — records a reason, terminal.
6. **Defer** (`{action:"defer"}`) — "seen but not actioned yet," returns
   to `PENDING` via a later allocate/reject/cancel.
7. **Release reservation** (`{action:"releaseReservation"}`) — "change
   destination" (brief §29): frees the reserved bed back to `AVAILABLE`
   and returns the request to `PENDING` without admitting.

Live-verified this phase: full request→allocate→confirm cycle produces a
real `Admission` + `OCCUPIED` bed + `ADMITTED` encounter; a second
concurrent allocation attempt on the same bed is rejected; reject and
release-reservation both correctly restore state.

## 2. Transfer

### States

```
TransferRequest.status:
  REQUESTED → ACCEPTED → BED_RESERVED → PATIENT_IN_TRANSIT → COMPLETED
  REQUESTED/ACCEPTED → CANCELLED/REJECTED (terminal)
```

### Flow

1. **Request** (`POST /api/hospital/transfer-requests`, permission
   `transfer:request`) — requires an active `Admission`. Safety checks
   (brief §35) reject up front if the admission is already discharged or
   another transfer request is already active for it.
2. **Accept** (`transfer:approve`) — a bed manager/admin acknowledges the
   request.
3. **Reserve destination bed** (via
   `GET .../[id]/eligible-beds` then `PATCH {action:"reserveBed", bedId}`)
   — same `findEligibleBeds()`/`transitionBed()` pattern as admission;
   rejects if the chosen bed is the patient's current bed.
4. **Mark in transit** (`{action:"markInTransit"}`, permission
   `transfer:execute`) — manual staff-set status, no automatic timer.
5. **Complete** (`{action:"complete"}`) — calls the existing
   `transferPatient()` (relaxed the same way as `admitPatient()`), which
   creates the real `Transfer` row, releases the old bed to `CLEANING`,
   occupies the new one — then links `TransferRequest.transferId`.

Live-verified this phase: full accept→reserve→complete cycle produces a
real `Transfer` row and moves the patient's `Admission.bedId`.

## 3. Discharge

Phase 0's `Discharge` model (six boolean readiness flags,
`dischargeSummary`, `signedByStaffId`) is unchanged in shape. Phase 2
adds:

- **`initiatedByStaffId`, `expectedDischargeAt`, `expectedDischargeReason`**
  — who started planning, and a trackable expected date with an explicit
  reason for each change (brief §39 — never silently overwritten).
- **The discharge barrier engine** (`src/lib/hospital/dischargeBarrierEngine.ts`,
  `GET /api/hospital/admissions/[id]/discharge/barriers`) — computes
  *why* a patient hasn't left, live, from the six readiness flags plus
  real pending-order state: unresulted lab orders, unreported imaging
  orders, unacknowledged critical results, and open (non-terminal)
  referrals. Deliberately not a stored field — see
  `docs/PATIENT_FLOW.md` §3 for why.
- **Work-queue bucketing** (`bucketDischarge()`) — assigns each discharge
  to one actionable bucket (`READY_TO_LEAVE`, or the label of its first
  blocking barrier: `Medically not ready`, `Billing blocked`,
  `Insurance blocked`, `Pharmacy blocked`, `Transport blocked`,
  `Documentation blocked`, or `Pending result`), satisfying brief §40's
  "every patient should have an actionable next step."

Live-verified this phase: a discharge with billing+insurance unmarked
correctly reports those two barriers blocked and buckets as `BILLING`;
marking them ready flips the bucket to `READY_TO_LEAVE`; finalizing then
correctly frees the bed to `CLEANING`, and the existing
`/api/hospital/beds/[id]/clean` endpoint (Phase 0, untouched) correctly
returns it to `AVAILABLE`.

## 4. What's still open

No payment-blocking real billing integration (Billing readiness is still
a manual flag, matching Phase 0's scope — `docs/MASTER_GAP_MATRIX.md`'s
"Payment recording" row is unrelated future work). No automated
LOS-variance analytics dashboard (the data — `expectedDischargeAt` vs.
`dischargedAt` — is captured and queryable, but no report is built on it
yet). No formal escalation chain when an SLA breaches (see
`docs/PATIENT_FLOW.md` §7).
