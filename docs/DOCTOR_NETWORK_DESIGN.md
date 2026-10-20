# Doctor network: design (5a)

- **Status:** Revision 1, 2026-10-19. A design only; nothing here is built until it is approved.
- **Spec:** `docs/PRODUCT_SPEC.md` feature C (doctor network).
- **Builds on:**
  - **Staff:** `HospitalStaffProfile` (a doctor's role at one facility: department, specialty text, licence number), `DepartmentMembership` and staff membership (`ensurePrimaryMembership`).
  - **The appointment and bookability engine** (`src/lib/hospital/appointment.ts`, `doctorSchedule.ts`, `scheduleBlocks.ts`):
    - `DoctorScheduleBlock` (clinic sessions, slot length, overbooking limit) and `StaffAbsence`;
    - `getAvailableSlots`;
    - `bookAppointment`, under a per-doctor advisory lock with `assertBookable`;
    - the events `AppointmentBooked` / `Cancelled` / `StatusChanged`.
  - **Patient self-booking** (`src/lib/patient/experience/appointments.ts`): today only doctors of the patient's own facility.
  - **Person identity:**
    - a person can hold records at many facilities;
    - `registerPatientAccount` / `connectFacilityRecord` create or link a facility record;
    - every person-level read goes through `personAccess`.
  - **Consent sharing (4c, `docs/CONSENT_SHARING_DESIGN.md`):** `RecordShare`, which a booking can attach.
- **ADRs:**
  - 0001: one Postgres;
  - 0003: an adapter for HPR later;
  - 0004: events, each in the writer's transaction.

## Contents

1. Goals and non-goals
2. The doctor identity
3. Data model
4. Verification first
5. Practice locations, fees and timings
6. Search
7. Booking with a record share
8. Access through the resolvers
9. Events
10. Gates
11. Order of wiring
12. Decisions taken for you
13. Open questions

## 1. Goals and non-goals

**Goals:**
- **A doctor is one identity across places:** a hospital post, their own clinic, teleconsultation.
- **A profile patients can trust:**
  - registration and state council (the verified badge);
  - qualifications;
  - specialties from a fixed list;
  - languages;
  - experience;
  - each location's fee, timings and modes.
- **Verification first:** a doctor is neither public nor bookable until verified.
- **Search** by specialty (with a symptom-to-specialty map), language, distance, fee, mode and next available slot.
- **Booking on the existing engine,** optionally attaching a record share.

**Non-goals:**
- HPR integration (the adapter is reserved; manual document checks now).
- Payments for consultation fees (5c covers paying in the app).
- Video calling itself (a teleconsult is a booked slot with a mode; the call provider is a later adapter).
- Reviews or ratings: none, and never paid placement (spec: "never selling search rankings").

## 2. The doctor identity

- **`Doctor`** is a platform-level identity, owned by the doctor's login (`User`, role DOCTOR). It is not tied to a facility.
- **`HospitalStaffProfile` stays the facility role.** A doctor is linked to each of their staff profiles through `DoctorStaffLink`, after both sides confirm:
  - the doctor claims the profile;
  - the facility's admin approves.
- **One staff profile, one doctor.** A staff profile belongs to at most one doctor.
- **Facility rosters are unchanged:** schedules, absences and appointments stay per facility.

The `Doctor` row holds the professional identity only. A doctor who is also a patient has a separate `Person` (and login), and the two are never joined (§12, decision 2).

## 3. Data model

All models are platform-scoped: they belong to no facility tenant and no Person. The tenancy sweep lists them as PLATFORM models, and reads go through `doctorDirectory` (§8).

```prisma
model Doctor {
  id                  String    @id @default(cuid())
  userId              String    @unique
  displayName         String
  registrationNumber  String
  stateCouncil        StateMedicalCouncil
  registrationYear    Int?                       // years of experience derive from it
  verificationStatus  DoctorVerificationStatus @default(UNVERIFIED) // UNVERIFIED | PENDING | VERIFIED | SUSPENDED | REJECTED
  verifiedAt          DateTime?
  verificationMethod  String?                    // DOCUMENT_CHECK | HPR
  hprId               String?   @unique          // reserved
  languages           String[]                   // app language codes
  listed              Boolean   @default(false)  // the doctor's own choice to appear in search; only when VERIFIED
  version             Int       @default(1)
  createdAt           DateTime  @default(now())
  @@unique([stateCouncil, registrationNumber])
}
model DoctorQualification { id, doctorId, degree (closed list), institution, year, verified Boolean }
model DoctorSpecialty     { doctorId, specialty Specialty /* fixed list */, primary Boolean; @@id([doctorId, specialty]) }
model DoctorStaffLink     { id, doctorId, staffId @unique, status LINK_PENDING | ACTIVE | ENDED, approvedByUserId, createdAt, endedAt }
model PracticeLocation {
  id, doctorId, kind HOSPITAL | CLINIC | TELE, facilityId, staffId   // where bookings land
  feeMinor Int?, modes ConsultMode[] /* IN_PERSON | VIDEO | HOME_VISIT */,
  pincode String?, lat Float?, lng Float?   // the facility's public address point, never the doctor's home
  active Boolean, version Int
}
model DoctorVerificationCase {
  id, doctorId, status OPEN | APPROVED | REJECTED | INFO_REQUESTED, documents (storage refs: registration certificate, degree),
  reviewerUserId?, decidedAt?, reasonCode?, createdAt
}
model SymptomSpecialtyMap { id, symptomCode, specialty, weight, version, approvedBy? }   // curated, versioned
model DoctorNextSlot      { practiceLocationId @id, nextSlotAt DateTime?, refreshedAt }  // a projection (§6.3)
```

- **Specialty** is a fixed list: the NMC broad specialties, in English with translated labels.
- **StateMedicalCouncil** is a closed list of the state councils.

## 4. Verification first

1. **The doctor registers** (a DOCTOR login) and submits their registration number, council, qualifications and the documents. A `DoctorVerificationCase` is opened in PENDING.
2. **A platform reviewer** (a new platform role, `DOCTOR_VERIFIER`, separate from facility admins) checks the documents against the council's public register by hand and approves or rejects with a reason code. Approval makes the doctor `VERIFIED`; nothing is public before that.
3. **`SUSPENDED`** (on a complaint, or a council action learned later) removes the doctor from search and from new bookings at once. Existing appointments stay, and the patients are told.
4. **HPR later:** an adapter verifies the registration automatically, and `verificationMethod` records which way.

**Before verification:**
- The doctor can still work as facility staff as today; facility employment is the facility's own check.
- They don't appear in the directory and can't be booked through it.

**Uploaded verification documents** are stored like other uploads (private bucket, signed URLs). Only the verifier and the doctor read them. They are deleted 90 days after the decision, and the decision and its reason code are kept.

## 5. Practice locations, fees and timings

- **HOSPITAL:** a facility where the doctor has an ACTIVE staff link. Bookings land on that staff profile and facility, on the facility's existing schedule blocks. The fee is the facility's (a published tariff line) or the doctor's listed fee if the facility allows it.
- **CLINIC:** the doctor's own practice. Under the hood it is a `Facility` of type CLINIC in the doctor's own `Organization`, created when the doctor adds the clinic, with the doctor as its only staff profile. The engine stays one engine: schedules, absences and the double-booking guard all apply unchanged.
- **TELE:** a location whose only mode is VIDEO, attached to the doctor's clinic facility (or a hospital that offers teleconsults). It follows the Telemedicine Practice Guidelines: the first consultation's identification and consent are recorded with the appointment.
- **Timings** are the location's `DoctorScheduleBlock` rows. The directory never stores a second copy of availability.

## 6. Search

### 6.1 Filters (SQL, all optional)

- specialty;
- language;
- mode;
- fee at most X;
- within D km of a point (bounding box on lat/lng, then the haversine distance);
- has a slot within N days.

Only `VERIFIED`, `listed` doctors with an active location appear.

### 6.2 Symptom to specialty

- The patient types or picks a symptom from a curated list (`SymptomSpecialtyMap`, translated). It maps to one or more specialties, with a "general physician" fallback always offered.
- The map is versioned, and each version is signed off by the clinical advisor.
- No free-text AI triage, no diagnosis, and the result always says "a general physician can also help".

### 6.3 Next available slot

- `DoctorNextSlot` is a projection. The `directory-slots` consumer refreshes it on these events:
  - `AppointmentBooked`, `AppointmentCancelled`, `AppointmentStatusChanged`;
  - schedule-block and absence events (`DoctorScheduleChanged`, new);
  - a nightly sweep, as the backstop.
- Search reads only the projection. The booking screen calls `getAvailableSlots` live, and `bookAppointment` decides under the lock, so a stale projection never double-books.

### 6.4 Ranking

Ranking is deterministic and explainable: specialty match, then distance, then next slot, then fee. There is no paid placement and no personalisation from health data: search never reads the searching person's record.

## 7. Booking with a record share

1. The patient picks a location and slot. If they have no record at that facility, one is created for them from their Person (the self-registration path), linked ACTIVE by their own action. It is the same rule as registering at a facility today: their own login, their own data, no matching against other people's records.
2. `bookAppointment` runs as today. `AppointmentBooked` v2 adds `channel: DIRECTORY` (v1 kept).
3. **Optional share:** "Share my record with Dr X for this visit". This creates a `RecordShare` (4c) of kind BOOKING:
   - the recipient is the doctor (`recipientUserId`);
   - the categories, sensitive opt-ins and period are chosen as in 4c;
   - it is valid from 24 hours before the slot until 24 hours after it;
   - it ends if the appointment is cancelled (a `share-lifecycle` consumer on `AppointmentCancelled`).

   The doctor's visit brief uses the share exactly as a code share.

## 8. Access through the resolvers

- **Public directory reads** (`doctorDirectory.search`, `doctorDirectory.profile`) return only the public fields of verified, listed doctors:
  - name, council, registration number;
  - qualifications, specialties, languages, experience;
  - locations with fee, modes and the facility's public address.

  They never return the doctor's login, contacts, documents or verification case.
- **Doctor-owned reads and writes** require the doctor's own login (`requireOwnDoctor`, the analogue of `requireOwnedPerson`).
- **Verifier reads** of cases and documents require `DOCTOR_VERIFIER`, and are audited.
- **A doctor reading a patient's record** is unchanged: through the care relationship at a facility, a share (4c), or break-glass. Every person-level read goes through `personAccess` / `shareGrant`. Being in the directory gives no access to anyone's data.

## 9. Events

Catalogue conventions: ids and closed codes only, `.strict()`, v1 unless noted.

| Event | Scope | Sensitivity | Payload |
|---|---|---|---|
| `DoctorRegistered` | PLATFORM | INTERNAL | `doctorId, stateCouncil` |
| `DoctorVerificationStatusChanged` | PLATFORM | INTERNAL | `doctorId, from, to, method?, reasonCode?` |
| `DoctorProfileUpdated` | PLATFORM | LOW | `doctorId, fields[]` (names of changed public fields) |
| `DoctorStaffLinkChanged` | FACILITY | INTERNAL | `linkId, doctorId, staffId, from, to` |
| `PracticeLocationChanged` | PLATFORM | LOW | `locationId, doctorId, kind, active, modes[]` |
| `DoctorScheduleChanged` | FACILITY | LOW | `staffId, facilityId` (schedule blocks or absences changed) |
| `AppointmentBooked` v2 | FACILITY | INTERNAL | v1 fields + `channel` |

**Consumers:**
- **`directory-slots`:** refreshes `DoctorNextSlot`.
- **`share-lifecycle`:** ends a booking share when its appointment is cancelled.

## 10. Gates

| Gate | Proves |
|---|---|
| `verify-postgres-doctor-verification` | An unverified, rejected or suspended doctor is absent from search and can't be booked through the directory. Approval makes them appear only once they choose `listed`. Each transition emits its event. Documents are readable only by the doctor and the verifier |
| `verify-postgres-doctor-directory` | Each filter (specialty, language, mode, fee, distance, slot window) admits exactly the expected fixtures. Symptom search uses only an approved map version. Ranking is deterministic. No non-public field appears in any response (canaries) |
| `verify-postgres-directory-booking` | Booking through the directory lands on the right facility and staff profile, under the double-booking guard (concurrent bookings: one wins). A stale `DoctorNextSlot` never double-books. Booking at a new facility creates and links the person's record. The attached share is scoped as chosen and ends on cancellation |
| `verify-postgres-doctor-leaks` | A directory doctor with no care relationship or share sees nothing of any patient (zero tolerance). Positive control: with a booking share, they see exactly its categories |
| Core journey (extended) | Search by symptom → book with a share → visit brief cites only the shared categories → cancel → the share ends |

## 11. Order of wiring

1. Models, enums and the migration; tenancy (PLATFORM); events; the `DOCTOR_VERIFIER` role.
2. Registration and verification (cases, documents, reviewer screens). Gate: doctor-verification.
3. Staff links and practice locations (the clinic facility under the doctor's own organization).
4. The `DoctorNextSlot` projection and its consumer; search and the symptom map. Gate: doctor-directory.
5. Booking through the directory, with the BOOKING share kind (4c extension). Gate: directory-booking.
6. Leak gate and core-journey extension.
7. Screens: doctor profile and onboarding, verifier queue, patient search and booking.

## 12. Decisions taken for you

1. **Verification is manual, by a platform role, against the council register.** HPR is an adapter later. Nothing is public before VERIFIED, and a doctor appears in search only when they also choose to be listed.
2. **A doctor's professional identity (`Doctor`) and a person's health identity (`Person`) are never joined,** even for the same human. Their logins stay separate, so a doctor's patient data is never reachable from their professional account.
3. **The doctor's own clinic is a `Facility` in their own `Organization`.** There is one booking engine, with all its guards.
4. **Distance uses the facility's public address,** never the doctor's home or the patient's stored address. The patient's location for a search is sent with the query and not stored.
5. **Search never reads the searching person's record.** There is no personalisation from health data, and no paid ranking.
6. **The symptom map is curated, versioned and signed off by the clinical advisor.** No AI triage.
7. **A booking share is kind BOOKING:** valid from 24 hours before the slot to 24 hours after, and ended by cancellation.
8. **A suspended doctor's existing appointments stay,** and the patients are told. New bookings stop at once.
9. **Verification documents are deleted 90 days after the decision.** The decision record stays.

## 13. Open questions

1. **Verifier:** who staffs `DOCTOR_VERIFIER` (Aarogya, or a partner), and what is the turnaround target?
2. **Fees at hospitals:** the facility's tariff only, or may a doctor list their own fee there?
3. **Home visits:** what safety rules apply to the address shared, and when is it shared (only after the doctor accepts)?
4. **Teleconsults:** which video provider (an adapter, India-hosted), and do recordings exist at all? The recommendation is none.
5. **Experience:** derive it from the registration year, or let the doctor state it (and verify how)?
6. **Same human, two roles:** should a doctor be able to switch to their patient account without logging out? The recommendation is no, for now.
7. **Clinical advisor:** the symptom list, its specialty map and the fallback wording.
