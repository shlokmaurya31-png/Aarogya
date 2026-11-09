# Offline nursing: the ward keeps working on bad Wi-Fi

- **Status:** Designed (Flagship 1d, 2026-10-28); the open questions decided (2026-10-29, §12); **phase 1, the server side, built in Flagship 2** (§13). The clinical advisor's sign-off on §6 is still needed before any MAR use on a ward: until it is recorded, offline mode can't be turned on for any ward (§13.5).
- **Scope:** the four nursing screens a ward can't stop for a dropped connection: the **MAR** (the medication round), **vitals**, **intake and output**, and **nursing tasks**.
- **Not in scope:** ordering, pharmacy verification, admission, transfer and discharge, the doctor's and the front desk's screens, billing. They stay online-only. When the network is down, those follow the hospital's paper downtime procedure, as now.
- **Builds on:** `administerMedication` (`src/lib/hospital/medicationLifecycle.ts`: a dose moves from DUE only once, by a guarded update), the MAR sweep (`marSweep.ts`: overdue doses become MISSED, and a late dose is recorded against the missed one), `NursingAssignment` (at most one open assignment per patient), `Vital`, `IntakeOutputRecord`, `Task`, the event spine (`docs/ARCHITECTURE.md` §4), and PRODUCT_SPEC principle 6 (weak networks, low-end Android).

## 1. The problem

Ward Wi-Fi drops in corridors, lifts and old buildings. Today a nurse who loses the connection halfway through a round can't see what's due and can't record what she gave, so she writes it on paper and enters it later, often hours later. The record is then wrong for those hours, the MAR sweep may mark given doses MISSED, and a second nurse can't see that the dose was given. **Double-dosing is the harm to design against.** Every rule below favours "the dose can't be given twice" over "the nurse can always record offline".

## 2. Goals and non-goals

| Goal | How we'll know |
|---|---|
| A nurse can run a full medication round, record vitals, I/O and tasks with no connection for up to one shift's worth of work | A gate replays a 4-hour partition |
| **No dose can be given twice** because of offline work | A gate with two devices, a partition and every interleaving finds no double GIVEN and no dose shown as givable on two devices |
| Everything recorded offline reaches the record, with the time it really happened | Gate: device times kept, server receipt time added, order preserved |
| Physical facts are never thrown away: a dose that was given stays given, even if the server disagrees | Gate: a conflict is recorded and flagged, never dropped |
| Offline data on a lost device is unreadable | Device encryption plus a remote wipe on unregistering |

Non-goals: offline ordering or order changes, offline access to the full chart, peer-to-peer sync between devices, offline AI.

## 3. Shape

```
shift start (online)            on the ward (online or not)           back online
──────────────────              ────────────────────────────          ───────────
download the WARD PACK   ──▶    read from the pack                ──▶  PUSH the outbox (facts first)
take DOSE LEASES                write COMMANDS to a local outbox       server applies each through the
                                (each with a client UUID)              existing services, in order
                                                                       PULL a fresh pack and leases
```

- **Client:** the existing Capacitor Android app (`android/`, `capacitor.config.ts`) and the browser app as an installable PWA. The local store is encrypted SQLite on Android, and IndexedDB with WebCrypto in the browser. The key is derived per device and per login, never stored in plain text.
- **Ward pack** (versioned, per nurse and shift): for each patient she's assigned (`NursingAssignment`), or each patient on her ward if the charge nurse allows it:
  - identity: name, UHID, bed, photo if any, allergies and their status;
  - active medication orders with their **order version**;
  - every scheduled dose (`MedicationAdministration`) from 2 hours ago to 8 hours ahead;
  - the last 24 hours of vitals and I/O;
  - open tasks;
  - the vitals thresholds (`VitalThreshold`) and the early-warning rules.

  The pack carries `issuedAt`, `expiresAt` (default **4 hours**; a hospital may allow up to 12, decided §12.4) and the server clock at issue. It also carries the **formulary snapshot** the device checks drug barcodes against offline (§12.5), and a read-only summary of the rest of the ward (§12.3).
- **Commands, not row edits.** The device never edits a row. It queues commands such as "dose X: GIVEN at T by nurse N", "vitals for encounter E at T", "I/O entry", "task K completed". Each command carries:
  - a client UUID (the idempotency key);
  - the device id and the nurse;
  - the device time, and that time corrected by the clock offset measured at pack issue;
  - the pack version it was made against.
- **Sync** is push-then-pull. The server applies commands in device order through the **existing services**, each in its own transaction with its catalogued event, exactly as an online action. A command it has already applied (same UUID) is answered "done" and changes nothing. Then the device pulls a new pack.

## 4. Dose leases: how double-dosing is prevented

Applying commands idempotently isn't enough. Two devices, each offline, could each show the same 08:00 dose as due, and both nurses could give it. The server can only notice afterwards. So **a dose can be given offline only on the one device that holds its lease.**

- **Taking a lease.** When the pack is downloaded, the server grants the device a lease on each scheduled dose of the nurse's assigned patients, for the pack's lifetime. The grant is a row per dose with a unique constraint on the dose, so two devices can't both hold one. It emits `DoseLeaseGranted`.
- **Effect online.** Any other device, and the online MAR, shows a leased dose as "with Nurse A's device until 14:00". It can be given elsewhere only after taking the lease over: the lease holder releases it, or the charge nurse revokes it, which the holder's device learns on its next sync. A dose given online by its lease holder needs no takeover.
- **Effect offline.** The device offers GIVEN only for doses it holds. Anything else in the pack is read-only, marked "not on this device". When a nurse covers a colleague's patient during a partition, nobody can give that patient's doses offline. The safe answer is the charge nurse's handover, which needs a connection, or the paper downtime sheet (§7).
- **Charge-nurse override (decided §12.2).** A charge nurse may take over a lease held by another device, online, with a reason. The override is logged with its reason, emits `DoseLeaseOverridden`, and the original device is told on its next sync (its dose shows "taken over by the charge nurse"). If that device gave the dose offline before learning it, the conflict rules (§5) flag a possible double dose.
- **Release.** Leases end at pack expiry, at handover (a new assignment), on unregistering a device, or by the charge nurse's revocation or override. Revoking the lease of a device that may be offline is risky, because it may have given the dose already. So the revoked dose is shown "possibly given offline: check the patient and Nurse A" until that device syncs or the revocation is confirmed in person.
- **Order changes.** A lease is on a dose of an order at a version. If the order is stopped, held or changed while the device is offline, the device doesn't know. That is the remaining risk, handled in §5.

## 5. Conflict rules

Rule zero: **a physical fact is never discarded.** If a nurse says she gave a dose, measured a pressure or emptied a drain, it goes into the record with the time it happened. When the server disagrees, the fact is kept with a conflict flag, the right people are told, and nothing is silently re-ordered.

| Situation on sync | Result |
|---|---|
| Dose GIVEN offline, the dose still DUE, the lease valid, the order unchanged | Applied as normal (`administerMedication`), with the device's time as `administeredAt` and the receipt time beside it. `MedicationAdministered` as today. |
| Dose GIVEN offline, already marked MISSED by the sweep while the device was away | Recorded as the late dose against the missed one (the existing `lateForAdministrationId` path). The MISSED dose is not re-labelled. |
| Dose GIVEN offline, but the order was stopped, held or changed after the pack was issued | **Recorded as given** (it was), with an `OFFLINE_ORDER_CHANGED` conflict. `OfflineConflictRecorded` is emitted, a task goes to the prescriber and the charge nurse, and the screen shows it at once. It never becomes "rejected". |
| Dose GIVEN offline by a device whose lease was revoked meanwhile | Recorded as given, with an `OFFLINE_LEASE_REVOKED` conflict. If another nurse gave the same dose online after the revocation, both are recorded and the conflict is **critical**: a possible double dose. An urgent task goes to the charge nurse and the prescriber, and an incident is raised (`docs/PHASE_6_7_NURSING.md`). |
| Same command twice (a retry) | The second is a no-op answered "done". |
| HELD or REFUSED offline | Applied as today (`MedicationDoseNotGiven`). The reason codes are in the pack. |
| PRN (as-needed) dose offline | Allowed only if the order allows offline PRN (§6), its minimum interval holds against both the local log and the last synced dose, and the daily maximum holds. Otherwise the button is disabled with the reason. |
| Vitals offline | Append-only, so there is no conflict. The early-warning score is computed on the device from the pack's thresholds. An alarming score shows "Call the doctor now" on the device, since paging can't wait for sync. On sync the server recomputes it and raises the usual alerts with the measured time. |
| I/O offline | Append-only. Totals and balance are recomputed on the server. |
| Task completed offline, already completed elsewhere | The first completion wins (the existing guarded update). The second is recorded as a note "also done by B at T", not an error. |
| Task cancelled on the server, completed offline | The completion is kept with a note. The task stays cancelled (the work was done, and the record says so). |
| Device clock wrong | Each command's time is corrected by the offset measured at pack issue. If the corrected time is in the future, or more than 12 hours before receipt, the command is applied with the receipt time, a `CLOCK_SUSPECT` flag and the device time kept beside it. It is never dropped. |
| Pack expired while offline | The device stops offering any dose, shows "Your offline list has expired: use the downtime sheet", and still allows vitals, I/O and task notes. Commands made before expiry still sync. |

Every conflict is a row (`OfflineConflict`: kind, severity, the command, the facts on both sides, who must look) with its catalogued event. The ward screen shows open conflicts until a named person resolves them.

## 6. Clinical rules the advisor must sign off

1. **Never offline:** controlled drugs (`isControlled`, which needs a witness), high-alert medicines (insulin infusions, heparin, potassium chloride concentrate, chemotherapy), first doses of a new order, blood products. These show "Online only: use the downtime sheet if the network is down".
2. **Offline PRN:** allowed only for orders the prescriber marks "PRN offline allowed", with the minimum interval and daily maximum enforced on the device.
3. **The dose window offline:** the same window as online (e.g. one hour either side). A dose outside it is not offered offline.
4. **The early-warning thresholds** the device uses, and the wording of "Call the doctor now". **Placeholder until then: NEWS2, pending clinical sign-off** (§13.6; Flagship 4, step 4d). The advisor may keep it, change its thresholds or replace it.
5. **What counts as a double-dose incident** and who is told.

## 7. Downtime, and back to paper

- Offline mode is not a replacement for the downtime procedure, just a shorter path through most outages. When the pack has expired, or a dose isn't on this device, the nurse uses the **downtime MAR sheet**: a printed or exported PDF of the pack, produced at shift start and kept on the ward.
- **Back-entry:** after downtime, paper entries are entered through a "record from paper" flow. It asks for the time from the sheet and marks the entry as such, with the same conflict rules.

## 8. Security and privacy

- **Registered devices only.** A ward device is registered by the facility (`WardDevice`, revocable). Personal phones only if the facility allows it, and never for controlled drugs.
- **Encryption at rest.** The pack and the outbox are encrypted. Logging out, a lease ending or unregistering the device deletes the pack. A device not seen for 24 hours wipes its pack the next time it starts.
- **Least data.** The pack holds only what the four screens need, for the assigned patients, for one shift. No notes, results, documents or AI text. Push notifications carry no patient detail.
- **Access log.** Downloading a pack is a read of each patient's record, logged like any staff read (`docs/ARCHITECTURE.md` §3). Person-level data (uploads) is never in a pack.
- **DPDP.** A pack is processing for the same purpose (treatment) by the same facility, so no new consent is needed. The retention and wipe rules go in the facility's privacy notice.

## 9. Data model and events (proposed)

- **New facility-scoped models:**
  - `WardDevice`: facility, label, registeredBy, status, lastSeenAt;
  - `WardPack`: device, nurse, version, issuedAt, expiresAt, clockOffsetMs;
  - `DoseLease`: administrationId (unique while active), device, pack, expiresAt, revokedAt;
  - `OfflineCommand`: client UUID (unique), device, kind, payload hash, deviceTime, receivedAt, outcome;
  - `OfflineConflict`.
- **New events (catalogued, strict, ids and codes only):** `WardDeviceRegistered`, `WardPackIssued`, `DoseLeaseGranted`, `DoseLeaseReleased`, `DoseLeaseRevoked`, `OfflineBatchApplied` (counts), `OfflineConflictRecorded`, `OfflineConflictResolved`. Applied commands emit their normal events (`MedicationAdministered`, `MedicationDoseNotGiven`, `ObservationRecorded` for vitals and I/O, `TaskCompleted`) and carry a new `origin: OFFLINE` in a new contract version of each, so consumers can tell.
- **Additive migrations.** No change to how an online dose is recorded.

## 10. Gates (before release)

- `verify-postgres-offline-mar`:
  - two devices with a partition: every interleaving of give, sync, revoke and give-online, with zero double GIVEN outside a recorded critical conflict;
  - a leased dose can't be given on another device;
  - a stopped order's offline dose is recorded and flagged;
  - an expired pack offers nothing;
  - a retried command is a no-op.
- `verify-postgres-offline-sync`:
  - device times kept and corrected;
  - a future time is flagged, not dropped;
  - push-then-pull order holds;
  - every applied command emitted its event in its transaction;
  - another facility's device can't push or pull (404).
- **Browser journey:** go offline mid-round (Playwright's offline mode), give two doses, record vitals, go online and see them on another nurse's screen.
- **Perf:** a 40-patient pack downloads under 2 seconds on a throttled 3G profile, and is under 1 MB.

## 11. Phases

1. Read-only offline: the pack, the downtime PDF, encrypted storage, wipe rules.
2. Vitals, I/O and tasks offline (append-only, low risk).
3. The MAR offline, with leases and the conflict rules, after the advisor signs off §6.
4. Back-entry from paper.

## 12. Decisions (2026-10-29; were the open questions)

1. **Shared ward tablets first. Decided.** Devices are the facility's shared ward tablets, registered per ward; a nurse signs in on the tablet, and a lease is held by the device for the nurse signed in when it was granted. Personal phones are not supported in phase 1.
2. **The charge nurse may override a lease. Decided.** Online, with a reason; the override is logged with the reason and the original device is told on its next sync (§4). Offline, a dose not on this device still goes to the downtime sheet.
3. **Pack = the nurse's assigned patients, plus a read-only ward summary. Decided.** Leases and givable doses only for assigned patients; the rest of the ward appears as bed, name, UHID, allergies and open-task counts, never givable.
4. **Offline limit: 4 hours by default, up to 12 if the hospital allows it. Decided.** A facility setting (`offline.packHours`, 1–12); the pack and its leases expire with it.
5. **Barcodes offline check a cached formulary snapshot. Decided.** The pack carries the facility's formulary codes for the patients' active orders; a scan that matches none is refused offline.
6. **The browser app is enough for now. Decided.** No iOS app; the installable browser app covers iPad wards.
7. **A possible double dose: the charge nurse resolves it within 15 minutes, and the pharmacist is told. Decided.** The conflict is CRITICAL, a task with a 15-minute due time goes to the ward's charge nurse, and the facility's pharmacists are notified.
8. **A downtime sheet as PDF every shift. Decided.** Generated from the pack at each shift start and kept on the ward (phase 2 of the client; the data is the pack).
9. **The charge nurse is per shift. Decided (2026-11-08; was Flagship 2's open question 1).** A shift roster names the charge nurse per ward per shift; the ward's named charge nurse is the fallback when a shift has none. Lease takeovers and conflict tasks go to the charge nurse of the shift that is on at that moment. As built in Flagship 3a (§13.1).

## 13. As built (Flagship 2, phase 1: the server side)

- **Models** (facility-scoped, migration `20261029120000_offline_nursing`): `WardDevice`, `WardPack`, `DoseLease` (one ACTIVE lease per dose, by a partial unique index), `OfflineCommand` (a unique client operation id per facility), `OfflineConflict`; plus `Ward.chargeNurseStaffId`, `Facility.offlinePackHours` (1–12, default 4, checked in the database) and `MedicationAdministration.offlineGivenForAdministrationId` (a GIVEN recorded offline for a dose no longer due: the second fact beside the first, never discarded; the scheduled-dose unique index skips it).
- **Service** (`src/lib/hospital/offline/service.ts`):
  - devices: register and revoke (revoking ends the device's leases);
  - the ward's charge nurse: named by the hospital admin;
  - the pack: the nurse's assigned patients with their allergies and due doses (from 2 hours ago to the pack's expiry), a read-only summary of the rest of the ward, the formulary barcodes of the patients' drugs, the measured clock offset, and a lease on each due dose no other device holds;
  - leases: renew (online), expire (a runner sweep), charge-nurse takeover with a reason (kept on the lease and in the audit log; the holder is told at its next sync);
  - sync: each command in its own transaction with its events; a replay answers what it answered before and changes nothing.
- **The online MAR refuses a dose a device holds** (`DoseLeasedError`, 409) until the holder's sync or a takeover.
- **Conflict rules as built:**
  - controlled and high-alert medicines (the order's flag, or the facility's formulary by name or by the dispensed item) are never leased; a command for one is refused as ONLINE_ONLY;
  - a dose recorded after its lease expired is refused (LEASE_EXPIRED);
  - a dose recorded with no lease is refused (NOT_LEASED);
  - a dose given offline after a takeover, or after its order changed, is recorded and flagged;
  - a dose given offline that was given online meanwhile is recorded as a second GIVEN and flagged as a possible double dose, CRITICAL;
  - every refused GIVEN is still kept (the command row, and a conflict for a person to review).
  Each conflict is a task for the ward's charge nurse (for a possible double dose: STAT, due within 15 minutes, and a task for the pharmacists; for a changed order, also for the prescriber).
- **Routes:**
  - `POST /api/hospital/offline/devices` and `…/devices/{id}/revoke` (hospital admin, `nursing:offline:manage`);
  - `POST /api/hospital/wards/{id}/charge-nurse` (hospital admin);
  - `POST /api/hospital/offline/pack`, `…/pack/renew`, `…/sync` and `…/leases/override` (nurses, `medication:administer`; the takeover only by the ward's charge nurse).
- **Events:** `WardDeviceRegistered`, `WardDeviceRevoked`, `WardChargeNurseDesignated`, `WardPackIssued`, `DoseLeaseGranted`, `DoseLeasesRenewed`, `DoseLeaseEnded`, `DoseLeaseOverridden`, `OfflineCommandRecorded`, `OfflineConflictRecorded`, `OfflineBatchApplied`. Applied doses emit the usual `MedicationAdministered` / `MedicationDoseNotGiven`. The new `origin: OFFLINE` version of those contracts (§9) is not added yet: the link is the command row.
- **Gate:** `verify-postgres-offline-sync`. It checks:
  - two devices, one lease;
  - a replayed sync is a no-op;
  - a possible double dose is flagged and the charge nurse told within 15 minutes;
  - an expired lease is refused;
  - an override is logged with its reason;
  - another facility gets a 404.
### 13.1 The charge nurse per shift (Flagship 3a, decided §12.9)

- **Roster:** `WardChargeShift` (migration `20261108090000_ward_charge_shifts`): ward, nurse, `[startAt, endAt)`, ACTIVE or CANCELLED. The hospital admin keeps it (`nursing:offline:manage`):
  - `GET` / `POST /api/hospital/wards/{id}/charge-shifts`;
  - `POST /api/hospital/offline/charge-shifts/{shiftId}/cancel`.
  A shift is at most 24 hours and can't already be over. Two ACTIVE shifts on one ward never overlap: the service refuses first (409), and an exclusion constraint is the guarantee under a race. Back-to-back shifts (one ends as the next starts) are fine.
- **Who is on:** `currentChargeNurse(ward, at)` (`src/lib/hospital/offline/chargeShift.ts`): the shift covering that moment, else `Ward.chargeNurseStaffId`, else none (the task then goes to the CHARGE_NURSE role).
- **Uses:**
  - a takeover is allowed only for the charge nurse on at that moment, and its audit row names the shift;
  - a conflict's task goes to the charge nurse on when the sync found it, so a lease that spans a handover is overridden by the incoming charge nurse, not the outgoing one.
- **Events:** `WardChargeShiftAssigned`, `WardChargeShiftCancelled`.
- **Gate:** `verify-postgres-charge-shifts`:
  - the roster (overlap refused, also under a race; another facility 404);
  - who is on at, before and after the handover, and with no shift on;
  - a handover mid-lease, for both the takeover and the conflict task;
  - a cancelled shift falls back to the named charge nurse.

### 13.2 Phase 2 on the server: vitals, I/O, tasks and PRN (Flagship 4a)

- **Commands:** `VITALS`, `INTAKE_OUTPUT`, `TASK_COMPLETED`, `PRN_GIVEN` and `PRN_BREACH_REFUSED`, through the same `POST /api/hospital/offline/sync`. They follow the same rules:
  - one transaction per command, with its catalogued events;
  - a replay is a no-op;
  - the device's time is corrected by its pack's measured offset, and a suspect clock is flagged;
  - nothing a nurse recorded is dropped: a refused command keeps what was sent (`OfflineCommand.payload`) and a `REFUSED_RECORD` conflict for review.
- **Whose records:** only patients with an open assignment to the nurse (else `NOT_ASSIGNED`), and only encounters, tasks and orders of this facility (else unknown).
- **Vitals and I/O:** written by the same services as online (`recordVitalsTx`, `recordIntakeOutputTx`), at the time measured. The server recomputes the early-warning flags (`ObservationRecorded.abnormal`). A value no measurement can have is refused and kept (`INVALID_VALUES`, ranges in `VITAL_RANGES`). Recording is allowed after the pack expires (§5).
- **Tasks:** completed with the time it was done. If the task was completed elsewhere first, the second completion is a note on the command ("also done by …"), not an error. If the task was cancelled, the completion is kept with a note and the task stays cancelled.
- **PRN (§6.2):**
  - **Order fields:** a PRN order now carries its minimum interval and maximum doses in 24 hours (both or neither, CHECK `MedicationOrder_prn_limits`), and the prescriber's `prnOfflineAllowed`, which is only possible with both limits. The pack lists each PRN order with its limits and the doses of the last 24 hours, so the device can hold them, and `givableOffline` only when allowed and not online-only.
  - **Online:** `POST /api/hospital/orders/medication/{id}/prn` refuses a breach (409).
  - **Offline, refused:** a PRN dose is refused (and kept) when the order isn't allowed offline (`PRN_NOT_OFFLINE`), is online-only (`ONLINE_ONLY`), or is recorded after the pack expired (`LEASE_EXPIRED`).
  - **Offline, a breach the device didn't know of** (doses given elsewhere meanwhile): the dose is recorded, because it was given, and flagged `PRN_LIMIT_BREACHED`, CRITICAL. The charge nurse's task is due within 15 minutes, and the pharmacists and the prescriber are told.
  - **Offline, a dose the device refused for its limits:** sent as `PRN_BREACH_REFUSED`, a flag for the charge nurse (`PRN_BREACH_ATTEMPT`) with no dose.
  - **Serialised:** PRN doses of one order are serialised online and offline (a row lock on the order).
- **Events:** `OfflineCommandRecorded` and `OfflineConflictRecorded` version 2 (any kind; ids only, never the values). The applied records emit their usual events (`ObservationRecorded`, `TaskCompleted`, `MedicationAdministered`).
- **Gate:** `verify-postgres-offline-phase2`.

### 13.3 The charge nurse's queue and the 15-minute escalation (Flagship 4b)

- **Screen:** *Offline queue* (`/hospital-os/nurse/offline-queue`, for nurses). The charge nurse on now (§13.1) sees their wards' items:
  - open conflicts, CRITICAL first: a possible double dose or a PRN dose over its limit, then refused claims and records, changed orders and the rest;
  - each with the patient, the drug, the device, the nurse, when it was recorded and the response time;
  - the doses taken over from a device until they are confirmed in person (§4), saying whether the device has synced since.

  Another nurse sees an empty queue.
- **Actions** (only the charge nurse on now, each with a reason, audited, with its event):
  - **resolve** a conflict as *patient checked: no harm*, *incident raised*, *one dose, recorded twice*, *the record stands* or *recorded online by me* (`POST /api/hospital/offline/conflicts/{id}/resolve`, `OfflineConflictResolved`). Its task is completed;
  - **confirm in person** a takeover (`POST /api/hospital/offline/leases/{id}/confirm`, `DoseLeaseOverrideConfirmed`).

  A database CHECK holds every resolved conflict to naming who, when, how and why.
- **Escalation (§12.7):** a CRITICAL conflict still open 15 minutes after the sync that raised it is escalated once by the runner (`escalateOfflineConflicts`, `OfflineConflictEscalated`). The facility's pharmacists get a STAT task and a CRITICAL notification each. This comes on top of the pharmacists' task at the time the conflict is raised.
- **Gate:** `verify-postgres-offline-queue`.

### 13.4 The ward device app (Flagship 4c, 4d)

- **What it is:** `/ward`, an installable web app for the shared ward tablet, for staff who give medicines. It has its own manifest (`/ward.webmanifest`, scope `/ward`) and service worker (`/ward-sw.js`). The service worker keeps only the app itself (the `/ward` page and its static files) and never caches an API response.
- **Setup:** the tablet keeps its device code (from the hospital admin's registration). The nurse signs in and downloads her list at shift start (`POST …/offline/pack`).
- **On the tablet** (`src/lib/ward/store.ts`):
  - the pack and the outbox live in IndexedDB, each record encrypted with AES-GCM under a key made on the tablet, which can't be exported;
  - "Hand back the tablet" deletes the pack, the outbox, the key and the app's cache, and it is refused while anything is waiting to sync.
- **Screens:** the medication round, PRN doses, vitals, intake/output and tasks.
  - **Doses:** Given, Held or Refused with a reason. A dose another tablet holds shows "Not on this device", and controlled and high-alert medicines show "Online only".
  - **PRN:** the tablet holds the minimum interval and the daily maximum against the pack's doses and its own outbox. A dose over a limit is not given, and a `PRN_BREACH_REFUSED` flag tells the charge nurse.
  - **Vitals:** a reading outside wide thresholds shows "Call the doctor now". The exact thresholds and the wording await the advisor (§6.4). (Replaced by the NEWS2 placeholder, §13.6.)
- **Offline:** a clear "Offline since hh:mm" banner. Every action is a command with its own id and the tablet's time, kept in the encrypted outbox. Past the facility's offline limit no dose can be given ("use the downtime sheet"), while vitals, intake/output and tasks are still recorded (§5).
- **Reconnect:** the tablet pushes the outbox in order, then pulls a fresh pack. A fresh pack re-grants the tablet's own leases in one transaction, so its doses stay givable. It reports what was recorded and what went to the charge nurse.
- **Journey:** `e2e/offline-ward.spec.ts` runs the whole round in Playwright:
  - download the list;
  - cut the network;
  - give a dose, record vitals, complete a task;
  - meanwhile, the charge nurse takes the second dose over and gives it online, and the tablet records it too;
  - reconnect.

  It then checks:
  - the dose was recorded at the time it was given;
  - the vitals and the task are in the record;
  - two GIVEN for the second dose;
  - the CRITICAL possible double dose is in the charge nurse's queue.
- **Not yet:** the downtime-sheet PDF, the Android (Capacitor) packaging, a remote wipe of a revoked tablet's store.

### 13.5 Offline mode per ward, behind the sign-off (Flagship 4e)

- **The flag stays:** the clinical advisor's sign-off of §6 is still pending. Offline mode is **off on every ward** (`Ward.offlineEnabled`, default off for every existing ward) until a hospital admin turns it on (`POST /api/hospital/wards/{id}/offline-mode`, with a reason, audited, `WardOfflineModeChanged`). Turning it on is refused while no sign-off is active.
- **The sign-off:** only platform staff (`platform:clinical-sign-off:record`) record it, with the advisor's name, the signed document's reference and the date (`POST /api/hospital/enterprise/clinical-sign-offs`, audited, `ClinicalSignOffRecorded`). One is active at a time. Revoking it (with a reason, `ClinicalSignOffRevoked`) turns offline mode off on every ward.
- **While a ward is off:** no pack is issued and no lease renewed (409). What a device already recorded still syncs, because a recorded fact is never refused for this.
- **Gate:** `verify-postgres-offline-switch`. The other offline gates turn their ward on through a synthetic sign-off in the verify database only (`scripts/lib/offlineFixture.ts`).

- **Not yet:**
  - the device app (encrypted store, outbox, downtime PDF);
  - vitals, I/O and task commands;
  - PRN offline;
  - resolving a conflict from a screen;
  - the advisor's sign-off on §6.

### 13.6 The early warning on the tablet: NEWS2 as the placeholder (Flagship 4, step 4d; pending clinical sign-off)

**Status: placeholder, pending clinical sign-off (§6.4).** The tablet shows this on screen, next to every score: "placeholder, pending clinical sign-off". Until the clinical advisor signs off the early-warning rule, "Call the doctor now" uses NEWS2 (Royal College of Physicians, 2017), unchanged, instead of the wide thresholds of §13.4. No other clinical rule changes. Nothing on the server scores or alerts on it, and the facility's own abnormal-vitals thresholds (`abnormalOf`) are untouched.

| Parameter | 3 | 2 | 1 | 0 | 1 | 2 | 3 |
|---|---|---|---|---|---|---|---|
| Respiration rate (/min) | ≤8 | | 9–11 | 12–20 | | 21–24 | ≥25 |
| SpO2 Scale 1 (%) | ≤91 | 92–93 | 94–95 | ≥96 | | | |
| Air or oxygen | | Oxygen | | Air | | | |
| Systolic BP (mmHg) | ≤90 | 91–100 | 101–110 | 111–219 | | | ≥220 |
| Pulse (/min) | ≤40 | | 41–50 | 51–90 | 91–110 | 111–130 | ≥131 |
| Consciousness | | | | Alert | | | New confusion, voice, pain, unresponsive (3) |
| Temperature (°C) | ≤35.0 | | 35.1–36.0 | 36.1–38.0 | 38.1–39.0 | ≥39.1 (2) | |

- **"Call the doctor now"** when the total is 5 or more, or any one parameter scores 3. At 7 or more it reads "Call the doctor now: emergency response". Below that there is no message. The live line under the vitals form shows the score and how many of the seven parameters were recorded.
- **Decided for you:**
  - SpO2 Scale 1 only. Scale 2, for hypercapnic respiratory failure, needs a clinician to choose it per patient, and the tablet can't know that.
  - A parameter not recorded scores nothing; the line says "n of 7 recorded" rather than guessing.
  - The tablet now asks "Room air / On oxygen" and the consciousness level (Alert, New confusion, Voice, Pain, Unresponsive). Both are sent with the vitals set and kept: `consciousness`, and `o2DeliveryMethod` as exactly "room air" or "supplemental oxygen".
- **For the advisor to decide:** whether to keep NEWS2 or change its thresholds, Scale 2, and the wording. (Whether the server scores synced sets was decided in Flagship 5a, §13.7.)
- **Code:** `src/lib/clinical/news2.ts` (was `src/lib/ward/news2.ts`; moved in Flagship 5a), with every band edge unit-tested in `news2.test.ts`; `src/components/ward/WardApp.tsx`.
- **Journey:** `e2e/offline-ward.spec.ts` checks the line and its "pending clinical sign-off" label, and that a red score alone calls the doctor. The `verify-postgres-offline-phase2` gate checks that the two new answers are kept.

### 13.7 The server scores synced sets with the same NEWS2 code (Flagship 5, step 3a; pending clinical sign-off)

**Status: placeholder, pending clinical sign-off (§6.4).** Decided with the task: the server scores every vitals set synced from the tablet with the tablet's own code, stores the score with the set and shows it with the same label. It alerts on nothing.

- **One module:** `src/lib/clinical/news2.ts` (moved from `src/lib/ward/`). The tablet scores its form with `news2`. The server's `VITALS` command scores the parsed set with `news2OfSyncedVitals`, which maps the tablet's two answers exactly: consciousness as one of the five levels, oxygen as "room air" or "supplemental oxygen". Any other value of those two is not scored (never guessed).
- **Stored with the set:** `Vital.news2Score`, `news2Parameters` (how many of the seven were recorded), `news2Red` (one parameter scored 3) and `news2Status` (`PENDING_CLINICAL_SIGN_OFF`, the rule's standing when it was scored; migration `20261110100000_vital_news2`, additive). A set recorded any other way (online forms, the ICU flowsheet) has no score: those screens don't ask the two NEWS2 questions.
- **Shown:** the chart's vitals list reads "NEWS2 n (k of 7 recorded) · placeholder, pending clinical sign-off".
- **No alerting:** no task, flag, notification or event is raised for the score, and the `ObservationRecorded` contract is unchanged (its `abnormal` still comes from the facility's thresholds, `abnormalOf`). The early-warning rule has no sign-off of its own yet; server alerting on NEWS2 would need the advisor's sign-off of §6.4 and a design of who is told, and is not built. The offline sign-off that turns offline mode on (§13.5) does not turn it on.
- **Gate:** `verify-postgres-offline-phase2`: the stored score equals the shared module's for the synced set (NEWS2 8, 5 of 7), with its status; nothing alerts (no task, no other event for the patient, and no server code other than the writer reads the stored score); an online set has no score.


### 13.8 No names in the cached ward shell (Flagship 5, step 3b)

Flagship 4 asked whether the cached ward shell should keep the signed-in nurse's name after logout. Decided with the task: it holds no personal names.

- **The page:** `/ward` renders without the nurse's name (`src/app/ward/page.tsx`). The tablet's service worker keeps a copy of this page for offline use (`public/ward-sw.js`, unchanged), so that copy now holds no staff or patient name.
- **The name loads after sign-in:** the app fetches it (`/api/scholar-auth/me`, no-store) and holds it in memory only, never in the cache or the store. Reloaded with the network cut, the header reads "Signed in" instead of the name.
- **Patient names** are only in the sealed store (the pack, AES-GCM under the tablet's non-exportable key), never in Cache Storage.
- **Hand back the tablet** (the ward app's sign-out) clears the name and the list from the screen, then deletes the store, the key and the ward cache (`wipe`), then signs out.
- **Journey:** `e2e/cache-privacy.spec.ts`, "the ward shell holds no names": with the list downloaded and the page reloaded from the worker, the cached shell holds neither the nurse's nor the patient's name, and the store holds them only sealed; after "Hand back the tablet", no name is anywhere in Cache Storage or IndexedDB, and the ward cache and store are gone.
