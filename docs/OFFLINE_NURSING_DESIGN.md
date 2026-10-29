# Offline nursing: the ward keeps working on bad Wi-Fi

- **Status:** Designed (Flagship 1d, 2026-10-28); the open questions decided (2026-10-29, §12); **phase 1, the server side, built in Flagship 2** (§13). The clinical advisor's sign-off on §6 is still needed before any MAR use on a ward.
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
4. **The early-warning thresholds** the device uses, and the wording of "Call the doctor now".
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
- **Not yet:**
  - the device app (encrypted store, outbox, downtime PDF);
  - vitals, I/O and task commands;
  - PRN offline;
  - resolving a conflict from a screen;
  - the advisor's sign-off on §6.

