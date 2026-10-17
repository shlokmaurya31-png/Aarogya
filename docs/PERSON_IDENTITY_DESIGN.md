# Person identity: design (Phase 0)

- **Status:** Approved 2026-10-17, with the answers in §15 (one reversal: pre-Phase-0 uploads stay visible to their facility; §10.3). Part 1 (models, resolver, linking, migration, gates) is being built.
- **Date:** 2026-10-17
- **Branch:** `foundation/w4-intelligence`
- **Spec:** `docs/PRODUCT_SPEC.md`:
  - vision ("a free, lifelong health record they own");
  - principles 2 (the patient owns the record), 3 (shared by consent) and 7 (one person, one record).
- **Builds on:**
  - the facility `Patient` with its UHID, `PatientIdentifier`, `ExternalIdentifier` (ABHA) and merges;
  - duplicate detection (`findDuplicateCandidates`, never cross-facility);
  - self-registration and linking (`PatientLinkRequest`: an OTP to the phone on the matched record, or front-desk review);
  - the consent service (`InteropConsent`);
  - the patient access scope and delegations;
  - the tenancy sweep, the facility-consistency gate and the one-patient gate.
- **Comes before:** 4a (document pipeline), 4b (RAG), 4c (consent sharing) and 5b (households). Each of them puts patient-owned data on the Person.

## Contents

1. Why a Person
2. Rules
3. Data model
4. Linking a facility record to a Person
5. Unlinking
6. Merges and duplicates
7. What belongs to the Person
8. Access and tenancy rules
9. Events
10. Migrating existing patients
11. Gates: tenancy sweep, facility consistency, leaks
12. Order of wiring, each step with its gate
13. Decisions taken for you
14. Open questions

---

## 1. Why a Person

Today a patient exists only as a facility record:
- `Patient.facilityId` is required;
- the UHID is the facility's;
- `Patient.userId` is unique, so a portal account belongs to exactly one facility record.

A patient treated at Pune and at Noida is two unrelated records, and their uploads belong to whichever facility they registered with. The vision needs something else: a record the patient owns, independent of any hospital, that they carry from one doctor to the next.

The **Person** is that owner:
- a platform-level identity tied to no facility;
- the patient controls it through their account;
- facility `Patient` records link to it once the link has been verified.

Facility records stay the facility's: their clinical record, their UHID, their legal record. The Person owns what the patient brings, gives and decides:
- uploads and the facts confirmed from them;
- consents;
- preferences;
- later, household membership.

## 2. Rules

1. **A Person belongs to no facility.** Person-level rows have no `facilityId`.
2. **A link needs verification.** A facility `Patient` links to a Person only after one of:
   - (a) **a phone code with a second factor:**
     - a one-time code is sent to the phone **on the facility's record** (not one the person typed in) and entered by the person;
     - the person's date of birth **or** the record's UHID matches the record exactly;
     - the record's phone was confirmed within the last 12 months (§4.1).
   - (b) **ABHA** verified on both sides (§4.3; behind a disabled flag).
   - (c) **In-person ID verification at the facility** (§4.5):
     - two staff members;
     - a reason code;
     - full audit, and the person is notified;
     - only the ID type and its last 4 digits are stored, **never a full Aadhaar number**.
3. **Never auto-link on a fuzzy match.** Duplicate detection may *suggest* a candidate, but nothing links until rule 2 is met.
4. **Each facility record links to at most one Person.** A Person may link to many facility records: one per facility, or more where the facility has unmerged duplicates.
5. **Facilities see person-level data only through consent or an active care relationship** (§8), and uploads only with the person's opt-in.
6. **Nothing is guessed.** A link, a merge or a migration step that can't be verified is refused or left pending, never inferred.
7. **Every link, unlink and merge is audited and evented**, and the person sees it in their access log.

## 3. Data model

### 3.1 `Person`

| Field | Notes |
|---|---|
| `id` | |
| `status` | `ACTIVE`, `LOCKED` (security hold), `MERGED` or `CLOSED` (the person deleted their account; retention rules apply) |
| `mergedIntoPersonId?`, `mergedAt?` | |
| `displayName` | What the person calls themselves. Not a legal name. |
| `dateOfBirth?`, `dobPrecision?`, `sex?` | Asserted by the person. Used for matching suggestions and age rules (minors, turning 18), never copied into facility records. |
| `preferredLanguage` | One of the 11 app languages. |
| `version`, `createdAt`, `updatedAt` | |

- **Person demographics are the person's own view.** Facility demographics stay on `Patient` and are never overwritten from the Person, or the other way round.
- A difference between them is shown to the person ("Pune has your name as …") and never "fixed" automatically.

### 3.2 `PersonAccount`: which logins act for a Person

| Field | Notes |
|---|---|
| `personId`, `userId` | `userId` is unique: a login acts as one Person's owner. |
| `role` | `OWNER` in Phase 0. Household roles (`MANAGER`, proxies) come in 5b and use the same table. |
| `createdAt`, `endedAt?` | |

Exactly one active `OWNER` per adult Person.

### 3.3 `PersonContact`: verified contacts

| Field | Notes |
|---|---|
| `personId`, `kind` | `kind` is `PHONE` or `EMAIL`. |
| `value` | Normalized (E.164 for phones). |
| `verifiedAt` | |
| `status` | `ACTIVE` or `REMOVED`. |

A partial unique index on `(kind, value) WHERE status = 'ACTIVE' AND verifiedAt IS NOT NULL`, so a verified phone belongs to one Person at a time (see §14 Q3 on recycled numbers).

### 3.4 `PersonIdentifier`: platform-level external identifiers

| Field | Notes |
|---|---|
| `personId`, `system` | `system` is `ABHA_NUMBER` or `ABHA_ADDRESS`. |
| `valueHash`, `valueLast4` | The value itself is encrypted at rest. The hash supports uniqueness and lookup. |
| `verificationStatus`, `verifiedAt`, `verifiedVia` | `verifiedVia` is `ABDM_AUTH` (when the ABDM integration exists) or `NONE`. |

Unique on `(system, valueHash)` where verified: one ABHA, one Person.

### 3.5 `PersonPatientLink`: the verified bridge to a facility record

| Field | Notes |
|---|---|
| `id`, `personId`, `patientId`, `facilityId` | `facilityId` is copied from the patient; a CHECK trigger enforces equality. |
| `status` | `PENDING_VERIFICATION`, `ACTIVE`, `UNLINKED`, `SUPERSEDED` (by a facility merge) or `REVERIFICATION_REQUIRED` (migration, §10) |
| `method` | `OTP_RECORD_CONTACT`, `ABHA_BOTH_VERIFIED`, `IN_PERSON_ID` or `SELF_CREATED` (the person's own registration created the facility record) |
| `idType?`, `idLast4?` | `IN_PERSON_ID` only. `idType` is closed: `AADHAAR`, `PAN`, `PASSPORT`, `VOTER_ID`, `DRIVING_LICENCE`, `OTHER_GOVT`. A CHECK makes `idLast4` exactly 4 characters. A full number is never accepted by the API and never stored. |
| `verifiedByStaffId?`, `approvedByStaffId?`, `reasonCode?` | `IN_PERSON_ID` only. A CHECK requires two different staff members. |
| `linkRequestId?` | The request that verified it. |
| `linkedAt?`, `linkedByUserId?` | |
| `unlinkedAt?`, `unlinkedBy?`, `unlinkedReason?` | `unlinkedBy` is `PERSON`, `FACILITY` or `PLATFORM`. The reason is a closed code: `PERSON_REQUEST`, `WRONG_PERSON`, `FACILITY_MERGE`, `PERSON_MERGE`, `SECURITY`. |
| `version` | |

- A partial unique index on `patientId WHERE status IN ('PENDING_VERIFICATION','ACTIVE','REVERIFICATION_REQUIRED')`: rule 4.
- A CHECK: `ACTIVE` requires `method`, `linkedAt` and `linkedByUserId`.

### 3.6 `PersonLinkRequest`: the existing `PatientLinkRequest`, extended

The existing model already does what rule 2 needs: a code sent to the phone on the matched record, hashed, with expiry and an attempt limit. It gains:
- `personId`;
- `method`: `OTP_RECORD_CONTACT`, `ABHA_BOTH_VERIFIED` or `IN_PERSON_ID`;
- `secondFactor` (`DOB` or `UHID`) and `secondFactorOk`, for the phone method;
- `initiatedBy`: `PERSON` (from the portal) or `FACILITY` (front desk starts it; the person still completes it).

**The front desk can no longer complete a link by deciding a review** (today `decideLinkRequest` LINK does). It can:
- start a request;
- confirm or update the contact on the record with the patient present (this sets `Patient.phoneConfirmedAt`);
- run the in-person ID verification (§4.5), which needs two staff members;
- reject a request;
- create a new facility record.

**`Patient.phoneConfirmedAt`** (new) is set only:
- when staff confirm or enter the phone with the patient present (registration at the desk, check-in "confirm contact", a demographic phone update);
- when a code sent to that phone is entered correctly.

Self-registration's typed-in phone never sets it. Existing rows start null, so they need a fresh confirmation or in-person verification.

### 3.7 `PersonMergeRecord`

| Field | Notes |
|---|---|
| `sourcePersonId`, `targetPersonId` | |
| `method` | `BOTH_ACCOUNTS_PROVEN` or `ABHA_SAME_VERIFIED` (§6.2) |
| `actorUserId` | |
| `reason` | A closed code. |
| `snapshot` | JSON of what was re-pointed, so the merge can be reversed. |
| `createdAt`, `reversedAt?` | |

### 3.8 Retired: `Patient.userId`

Readers move to `PersonAccount` → `PersonPatientLink`. The column is kept, read-only, until every reader has moved; a later migration drops it. While it exists, a CHECK-backed consistency test asserts that every `Patient.userId` matches an ACTIVE link via the user's Person.

## 4. Linking a facility record to a Person

### 4.1 From the portal (the person starts)

1. **The person signs in** (their Person exists from registration) and chooses "connect a hospital record": a facility, plus claimed details (name, DOB, sex, phone).
2. **The facility's duplicate detection** runs within that facility only, as today.
   - **No likely match:** nothing to link. The person may ask the facility to register them (as today's self-registration does), which creates the record with a `SELF_CREATED` link.
   - **Already linked:** a match already linked to another Person goes to front-desk review. Nothing is revealed to the requester beyond "we couldn't verify this automatically".
   - **A likely match whose phone was confirmed within 12 months:** the person must first give a second factor that matches the record exactly: their date of birth, or the UHID printed on a bill or card. Only then is a code sent to **the record's** phone, and the person sees the masked number. A wrong second factor counts as a failed attempt, and the person isn't told which part failed.
   - **A likely match with no phone, or one not confirmed within 12 months:** go to step 3.
3. **Fallback, in-person verification (§4.5):** the person is told to visit the front desk.
4. **The correct code, with the second factor matched → link `ACTIVE` (`OTP_RECORD_CONTACT`).** It also sets `phoneConfirmedAt`.
   - It emits `PersonPatientLinked`.
   - It is audited at the facility (`patient.person.linked`) and in the person's access log.
5. **Wrong codes:** expired or too many wrong attempts send the request to `FRONT_DESK_REVIEW` (as today), where only a re-send can follow, never a staff link.

### 4.2 From the facility (the front desk starts)

At registration or check-in, the front desk can offer: "Link this record to your Aarogya account."
- It sends a code to the contact on the record. The person enters it in their app (signed in), or signs up and then enters it.
- Staff never see the code or the person's account details.

### 4.3 ABHA

- **The facility side:** the facility record carries an `ExternalIdentifier` ABHA with `verificationStatus = VERIFIED` (verified through ABDM by the facility).
- **The person side:** the Person carries a `PersonIdentifier` ABHA verified through ABDM.
- **When the values match, the link is offered** (method `ABHA_BOTH_VERIFIED`) and becomes `ACTIVE` when the person accepts it in the app. It is never linked silently.
- **Until ABDM authentication exists**, neither side can be `VERIFIED` through ABDM. This path is designed and gated, but unavailable (`verifiedVia = NONE` never counts).

### 4.4 Audit

Every request, code sent (masked destination only), attempt, link and refusal is written to:
- the facility audit (`patient.person.link.*`), with `facilityId` and `patientId`;
- the person's access log (`PersonAccessLogEntry`, shown in the app): "Your record at Aarogya Medical Centre, Pune was connected on …".

### 4.5 In-person ID verification

The person is present at the facility, signed in to their app (or signing up there).
1. **Staff member A** checks a government ID against the record and the person, and enters:
   - the ID type and its last 4 digits (the API rejects anything longer than 4 characters, and any 12-digit Aadhaar-shaped input);
   - a reason code: `NO_PHONE_ON_RECORD`, `PHONE_NOT_CONFIRMED`, `PHONE_UNREACHABLE` or `SECOND_FACTOR_UNAVAILABLE`.
2. **Staff member B**, a different staff member with `patient:identity:verify`, approves.
3. **The person confirms** in their app ("Connect your record at …?").
4. **The link becomes `ACTIVE` (`IN_PERSON_ID`).**
   - It emits `PersonPatientLinked` with `method`.
   - It is audited with both staff ids and the reason code.
   - The person is notified, and it appears in their access log.

## 5. Unlinking

| Who | When | Effect |
|---|---|---|
| Person | Any time, from the app | The link → `UNLINKED` (`PERSON_REQUEST`). The facility keeps its records, unchanged. The facility loses person-level access through this link (uploads, person-level consents). The person no longer sees that facility's records in the portal. |
| Facility | Wrong person (`WRONG_PERSON`), or a security incident | Requires `patient:identity:unlink`, a reason code and a second, different staff member's approval (two-person rule). The person is notified. Person-level data derived from that facility's records (index chunks, conflicts) is withdrawn. The person's own uploads are untouched. |
| Platform | `SECURITY` (account takeover), `PERSON_MERGE` | Through the safety-officer role, audited. |

- Unlinking never deletes clinical data on either side.
- Relinking is a new verification (§4), never a reactivation.
- It emits `PersonPatientUnlinked`.

## 6. Merges and duplicates

### 6.1 Facility record merges (existing `mergePatients`)

| Source link | Target link | Behaviour |
|---|---|---|
| None | None | As today. |
| Person P | None | The target gains a link to P (`ACTIVE`, method carried with `linkRequestId` from the source). The source's link → `SUPERSEDED`. Evented. |
| None | Person P | As today. The target keeps its link. |
| Person P | Person P | The source's link → `SUPERSEDED`. |
| Person P | Person Q (Q ≠ P) | **Refused** (`PersonLinkConflictError`). The two Persons must be resolved first (§6.2), or the wrong link unlinked (§5). |

`unmergePatients` restores the links exactly as they were before the merge. The merge record keeps the prior link state.

### 6.2 Person duplicates

One human with two Persons, for example two accounts made with different phones. A Person merge needs one of:
- **`BOTH_ACCOUNTS_PROVEN`:** the human signs in to both accounts in one session and confirms a code sent to a verified contact of each;
- **`ABHA_SAME_VERIFIED`:** both Persons carry the same ABDM-verified ABHA. This can't actually happen given the uniqueness rule in §3.4; it is listed for imported data.

Staff can never merge Persons, and neither can a fuzzy match.

What a merge does:
- re-points every person-owned row (§7) from the source to the target in one transaction;
- sets the source to `MERGED` with its pointer;
- moves the accounts (the source's login becomes a second `OWNER` login only if the human asks, otherwise it is ended);
- re-points the links.

Reads resolve the merge chain (like `resolvePatientIdsForRead`). It is reversible from the snapshot. It emits `PersonMerged`.

### 6.3 Suspected duplicates

Duplicate detection may tell a person "you may already have an account" only through a verified contact they control. It never says which account or facility.

## 7. What belongs to the Person

| Data | Owner | Notes |
|---|---|---|
| Uploads (photos, PDFs) | Person | New `PersonDocument` (§10.3 for existing uploads). Not a `ClinicalDocument`: those are facility documents. |
| The document pipeline's runs, text, translations, facts | Person | `docs/DOCUMENT_PIPELINE_DESIGN.md` is re-pointed accordingly. |
| `PatientProvidedRecord` | Person | |
| Consents given by the patient | Person | `AI_ASSISTANCE`, `DOCUMENT_PROCESSING`, `AI_TEXT_RETENTION`; the upload-sharing choice; shares (4c). Facility-recorded consents (surgery, procedures, a consent obtained offline by staff) stay facility consents. |
| Preferences | Person | Language; "share my uploads with hospitals treating me" (§8.3). |
| Household membership (5b) | Person | |
| Access log | Person | Every access to person-level data, and every link event. |
| Clinical records (encounters, results, notes, orders, bills) | Facility `Patient` | Seen by the person through their ACTIVE links. Shared to others only through consent (4c). |

**Consent model.** Per decision 9, the existing `InteropConsent` is reused. It gains:
- `subjectPersonId` and `grantorPersonId`;
- `facilityId` becomes nullable, with a CHECK: `facilityId IS NOT NULL OR subjectPersonId IS NOT NULL`.

A person-given consent has `subjectPersonId` set and the recipient as today (FACILITY, ORGANIZATION, PRACTITIONER, PLATFORM). 4c extends it.

## 8. Access and tenancy rules

### 8.1 A new tenancy segment: PERSON

Person-scoped models have no `facilityId`:
- `Person`, `PersonAccount`, `PersonContact`, `PersonIdentifier`;
- `PersonDocument` and the pipeline models;
- `PatientProvidedRecord`;
- person-subject consents;
- `PersonAccessLogEntry`.

Every read goes through one resolver:

```ts
personAccess(actor, personId, purpose): { categories: Category[]; via: "OWNER" | "PROXY" | "CONSENT" | "CARE_RELATIONSHIP" } | null
```

Routes and services never query person-scoped tables by `personId` from a request without it. The tenancy sweep enforces this (§11).

### 8.2 Who sees what

| Actor | Sees |
|---|---|
| The person (OWNER login) | Everything person-level, and their linked facility records |
| A proxy (5b) | What their permissions and categories allow |
| Facility staff, with an **active care relationship** | Person-level data only as consented: uploads and patient-provided facts only with the opt-in (§8.3); AI over person-level data only with `AI_ASSISTANCE` |
| Facility staff, with a **consent** (share, approved request; 4c) | The consent's categories and date range |
| Another facility in the same organization | Only with the person's consent (an organization-recipient consent) |
| Anyone else | Nothing. A 404, not a 403. |

**An active care relationship** means all three hold:
- an ACTIVE link at the staff member's facility;
- an encounter in the window:
  - **OPD:** up to 30 days after the last encounter ended (or began, if it has no end);
  - **IPD:** the whole admission, plus 30 days after discharge;
  - both windows are configurable per facility (`identity.care_window_opd_days`, `identity.care_window_ipd_days`), with a platform maximum of 90 days enforced by the config registry;
- the staff member's chart permission for that patient.

Break-glass (existing, audited, time-limited) can open person-level data in an emergency. It is shown to the person.

### 8.3 Upload sharing with treating hospitals

During onboarding the person is asked: "Share my uploads with hospitals treating me?"
- **Yes / No, with neither pre-selected.** The choice must be affirmative (DPDP).
- It is changeable any time in settings.
- It is stored as a person-subject consent with purpose `TREATMENT`, recipient type `TREATING_FACILITIES`, and scope `UPLOADS` and `PATIENT_PROVIDED`.
- **Until they choose, the answer is no.** Treating-facility clinicians see uploads and confirmed patient-provided facts only while it is granted, and only with an active care relationship.

### 8.4 Facility data stays facility data

- A facility never sees another facility's `Patient` records through the Person. That is 4c sharing.
- The portal shows the person each linked facility's records separately, labelled by facility.

## 9. Events

Event contracts as everywhere: strict Zod, IDs and closed codes only.

**The envelope gains `personId`**, alongside a new scope:
- `scope: "PERSON"` means no organization or facility; `personId` is required;
- `FACILITY`-scoped events about a linked patient may also carry `personId`, so person-level consumers (the rag-indexer, the pipeline) can find the owner.

| Event | Scope | Sensitivity | Payload |
|---|---|---|---|
| `PersonCreated` | PERSON | INTERNAL | `personId`, `source` (SELF_REGISTRATION \| MIGRATION) |
| `PersonContactVerified` | PERSON | INTERNAL | `personId`, `contactId`, `kind` |
| `PersonIdentifierVerified` | PERSON | SENSITIVE | `personId`, `identifierId`, `system` |
| `PersonPatientLinkRequested` | FACILITY | INTERNAL | `requestId`, `personId?`, `patientId?`, `facilityId`, `method`, `initiatedBy`, `route` (OTP_SENT \| FRONT_DESK_REVIEW) |
| `PersonPatientLinked` | FACILITY | SENSITIVE | `linkId`, `personId`, `patientId`, `method` |
| `PersonPatientUnlinked` | FACILITY | SENSITIVE | `linkId`, `personId`, `patientId`, `by`, `reason` |
| `PersonPatientLinkSuperseded` | FACILITY | INTERNAL | `linkId`, `newLinkId?`, `mergeRecordId` |
| `PersonMerged` | PERSON | SENSITIVE | `sourcePersonId`, `targetPersonId`, `mergeRecordId`, `method` |
| `PersonPreferenceChanged` | PERSON | INTERNAL | `personId`, `preference` (LANGUAGE \| SHARE_UPLOADS_WITH_TREATING) |
| `PersonLinkReverificationRequired` | FACILITY | INTERNAL | `linkId`, `personId`, `patientId`, `reason` (MIGRATION_UNVERIFIED) |

Person-level consents emit the existing consent events (`ConsentGranted`, `ConsentRevoked`), now with `personId`.

The emit rule, catalogue doc and core journey cover all of them.

## 10. Migrating existing patients

A script (`npm run identity:migrate`) with a dry run that writes a report. It is idempotent and resumable, and **it refuses rather than guesses**.

### 10.1 Accounts → Persons

For each `User` with role `PATIENT` and a `Patient.userId` link, the migration first checks the facility record:
- **Merged into another record:** resolve to the canonical record. If the canonical record is linked to a different user: **refuse and report**.
- **Not merged:** create a `Person` (`source = MIGRATION`), an `OWNER` account and a contact for the user's verified email.

The link then depends on how the account was linked:

| Evidence | Link |
|---|---|
| The facility record was created by this account's self-registration (the `patient.account.registered` audit event with this user and patient) | `ACTIVE`, `SELF_CREATED` |
| An OTP-verified `PatientLinkRequest` (status LINKED, no `resolvedByUserId`, matching user and patient) | `ACTIVE`, `OTP_RECORD_CONTACT` |
| Front-desk linked (`decideLinkRequest` LINK), seeded or demo links, or no evidence | `REVERIFICATION_REQUIRED`. The person is asked to verify by OTP; until then the link gives no person-level access in either direction. |

Facility patients without an account get **no Person**. A Person appears only when someone claims the record through §4.

### 10.2 Delegations

Existing `PatientDelegation` rows stay facility-patient delegations until 5b. The migration records each against the subject's Person when that Person's link is `ACTIVE`. Otherwise it leaves them as they are.

### 10.3 Uploads

For each patient-uploaded `ClinicalDocument`:
- **The uploader's link is ACTIVE and the uploader is that patient's OWNER:** create a `PersonDocument` with the same `storageRef` and `sha256` (no byte copy), and mark the old row `migratedToPersonDocumentId`.
- **Otherwise:** leave it, report it, and retry after re-verification.

**Visibility of old uploads (the reversal):** an upload made before Phase 0 stays visible to the facility it was uploaded to, under the old rule (its care team), because that was the patient's expectation at upload.
- The `PersonDocument` records `legacyVisibleToFacilityId`.
- On the person's next login, the app asks them to choose the sharing setting (§8.3), with no pre-selected answer.
- From then on, their choice governs every upload, old ones included.
- Until they choose, the old uploads keep their old visibility. New uploads are hidden from facilities.

### 10.4 Report

Counts for:
- Persons created;
- links ACTIVE, broken down by method;
- links REVERIFICATION_REQUIRED;
- refusals, each with its reason;
- uploads moved, and uploads left.

The script exits non-zero on any refusal unless `--accept-refusals` is given. Even then the refused rows are untouched.

## 11. Gates: tenancy sweep, facility consistency, leaks

- **Tenancy sweep (`verify-postgres-tenancy-sweep`):**
  - a new `PERSON` segment in `SEGMENT_MODELS`, with fixtures for two Persons;
  - for every person-scoped route: the other Person's id → 404 for a patient, for staff without access, and for staff of another facility;
  - for staff with a care relationship: allowed only for the categories the consent or opt-in grants.
- **Facility consistency (`verify-postgres-facility-consistency`):**
  - person-scoped models are exempt from the facility rule because they have no `facilityId`;
  - `PersonPatientLink.facilityId` must equal its patient's facility;
  - a FACILITY-scoped event's `personId` must have an ACTIVE or SUPERSEDED link to the event's patient.
- **One patient (`verify-postgres-one-patient`):** the portal shows a person's linked records from two facilities, each labelled. An unlinked or REVERIFICATION_REQUIRED record shows nothing.
- **New `verify-postgres-person-identity`:**
  - an OTP link happy path;
  - a code goes only to the contact on the record;
  - a fuzzy match never links;
  - front desk cannot link;
  - wrong-code lockout;
  - unlinking by the person and by the facility (two-person rule);
  - the facility merge table (§6.1), including the refusal;
  - unmerge restores links;
  - a Person merge needs both accounts proven;
  - the migration's classification and refusals on fixtures.
- **New `verify-postgres-person-leaks`:** canaries in Person B's uploads, facts and consents, then checks every actor in §8.2:
  - a treating facility without the opt-in → nothing;
  - with the opt-in, inside a care relationship → only uploads and facts;
  - outside the care window → nothing;
  - after an unlink → nothing;
  - another facility in the same organization without consent → nothing;
  - Person A's own account → nothing of B's;
  - a merged source id → resolves to the target for the owner only.

  Zero leaks required. 4a and 4b extend it.

## 12. Order of wiring, each step with its gate

Each step is its own commit. `verify:all`, `npm test`, lint and build stay green after each.

| # | Step | Gate |
|---|---|---|
| 1 | Models and migration: `Person`, `PersonAccount`, `PersonContact`, `PersonIdentifier`, `PersonPatientLink` (partial unique, CHECKs, facility-equality trigger), `PersonMergeRecord`, `PersonAccessLogEntry`; `PatientLinkRequest` extended; the PERSON tenancy segment; the outbox `personId` and the PERSON scope | Migration on a fresh database; drift check; constraint tests; the tenancy sweep with the PERSON segment. |
| 2 | Event contracts (§9) and `personAccess()` | Unit tests: contracts; the resolver's decision table (§8.2). |
| 3 | Registration creates a Person; the portal reads go through Person → links (`requirePatientContext` re-pointed); the `Patient.userId` consistency test | The one-patient gate with two linked facilities; existing portal gates unchanged. |
| 4 | Linking (§4.1–4.2) and its audit; front-desk LINK removed | `verify-postgres-person-identity` part 1. |
| 5 | Unlinking (§5) with the two-person rule | Part 2. |
| 6 | Facility merge and unmerge link handling (§6.1); Person merge (§6.2) | Part 3. |
| 7 | `PersonDocument`; uploads write to it; the upload-sharing choice (§8.3) as a person consent; `InteropConsent` person columns | `verify-postgres-person-leaks`. The upload gate: new uploads are person-owned and hidden from the facility until opt-in. |
| 8 | The migration script (§10), with dry run and report | Its gate on a seeded fixture set covering every classification and refusal; a second run changes nothing. |
| 9 | ABHA linking (§4.3), behind the ABDM switch | Part 4: unavailable without ABDM verification; with fixtures of both sides verified, offered and only linked on acceptance. |

## 13. Decisions taken for you

All take the more conservative option and can be reversed.

- **The front desk can no longer complete a link.** It can start one and update the contact on record after an in-person check, but the person enters the code. The current `decideLinkRequest` LINK path goes.
- **Unverified existing links are not trusted:** front-desk-linked, seeded or of unknown origin. They become `REVERIFICATION_REQUIRED`, with no person-level access until the person verifies.
- **Old uploads after the person's choice.** Old uploads keep their facility visibility until the person makes the sharing choice, and that choice then covers old uploads too (§10.3). The reversal says old uploads "stay visible"; I read that as until the person decides, since the next-login prompt exists to let them decide.
- **A facility unlink needs two staff members** and a reason code, and the person is notified.
- **A Person merge needs proof of control of both accounts.** Staff can never merge Persons.
- **Person demographics never sync with facility demographics** in either direction. Differences are shown.
- **One verified phone belongs to one Person** at a time.
- **The care-relationship window defaults to 30 days** after the last encounter.
- **ABHA linking is designed but unavailable** until ABDM verification exists. A typed-in ABHA never counts.

## 14. Open questions (answered 2026-10-17; see §15)

1. **Patients with no phone on record (or none that works).** A code can't reach them. The design makes the front desk update the contact after an in-person identity check and then send a code. Is a documented in-person ID check at the front desk acceptable as a link method in its own right, without a code? For example for elderly patients without phones, audited and two-person. That would add a third method beyond decision 1.
2. **Existing uploads and the care team.** Hiding past uploads from clinicians until opt-in is the strict reading of decision 3. Do you want that, or should uploads made before Phase 0 stay visible to the facility they were uploaded to (the old rule) until the person chooses?
3. **Recycled phone numbers.** Indian numbers are reassigned. A code to a stale number on a facility record could reach a stranger. Should a link by phone code also require a second claimed detail to match the record exactly (DOB, or the UHID printed on a bill), or a contact updated within N years?
4. **The care-relationship window.** Is 30 days after the last encounter right for "treating hospital"? Should it differ for inpatient and outpatient?
5. **Minors before households.** Phase 0 covers adults with their own account. Do minors' facility records wait for 5b (guardian-managed Persons), or should Phase 0 let a parent create a child's Person now?
6. **Account deletion.** When a person closes their account (`CLOSED`), what happens to their uploads and patient-provided facts? Delete after the retention period, or keep under records retention because a clinician may have relied on them?

## 15. Answers (2026-10-17)

| # | Answer | Where |
|---|---|---|
| 1 | In-person ID verification is a link method: two staff members, a reason code, full audit, the person notified; only the ID type and its last 4 digits are stored, never a full Aadhaar number | §2, §3.5, §4.5 |
| 2 | Reversal: pre-Phase-0 uploads stay visible to the facility they were uploaded to; the person is asked to choose at next login | §10.3 |
| 3 | Phone codes need a second factor (DOB or UHID exactly) **and** a phone confirmed within 12 months; otherwise in-person verification | §2, §3.6, §4.1 |
| 4 | Care relationship: OPD 30 days after the last encounter; IPD the admission plus 30 days after discharge; per facility, platform maximum 90 days | §8.2 |
| 5 | Minors' Persons wait for households (5b) | — |
| 6 | Account closure: patient-provided data deleted after a 30-day grace period; whatever a clinician confirmed into a facility record follows records retention | §3.1 (`CLOSED`) |
| 7 | WHO INN: a one-time curated, versioned import, refreshed yearly; brand list after the pilot | pipeline §5.1 |
| 8 | Withdrawn shared allergies: unconfirmed copies go inactive with a content-free flag; warn the patient first; prompt clinicians at the point of care | pipeline §3 |
| 9 | 90-day lapse window; reviewers read staff text, and patient text only where the opt-in explicitly allowed safety review | RAG §4.3 |
| 10 | p95 < 150 ms at 20,000 chunks, enforced by a latency gate | RAG §12 |

