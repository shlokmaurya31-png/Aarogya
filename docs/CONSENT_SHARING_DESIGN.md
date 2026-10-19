# Consent sharing: design (Week 4c)

- **Status:** Revision 1, 2026-10-19. Built in Week 4c on branch `foundation/w4c-sharing`; §13 records where the code departs from this text.
- **Spec:** `docs/PRODUCT_SPEC.md` feature B (consent sharing).
- **Builds on:**
  - **Person identity** (`docs/PERSON_IDENTITY_DESIGN.md`):
    - consents the patient gives belong to the `Person`;
    - every person-level read goes through `personAccess`;
    - the person's access log is `PersonAccessLogEntry`.
  - **The one-visit code** (`PatientAccessSession`, `src/lib/patient/accessSession.ts`): the patient issues an 8-character code, a doctor redeems it, and the consult stays open for 15 minutes, extendable.
  - **RAG access paths** (`src/lib/rag/access.ts`, `docs/RAG_DESIGN.md` §7.1 and §16.6). The SHARE path is the code. It has no category or date choice, so today it never includes uploads or a sensitive category, and its date limit is tested only on the timeline's period (the 4b stand-in this design replaces).
  - **Retrieval scopes** (`src/lib/rag/scope.ts`): categories, sensitive opt-ins, origins and a recorded-at period, all filtered in SQL.
  - **The consent engine** (`InteropConsent`, `src/lib/consent`): facility-tenanted consent artefacts (purpose, scope, recipient, validity) used for interoperability and for same-organization access.
  - **Break-glass** (`BreakGlassAccess`) and treating-hospital access (the care relationship): both unchanged here.
- **ADRs:**
  - 0001: one Postgres;
  - 0004: modules sync through events, and every state change emits its catalogued event in the same transaction.

## Contents

1. Goals and non-goals
2. What a share covers
3. Data model
4. The one-visit code, upgraded
5. Access requests
6. Sensitive categories
7. The access log and "revoke all"
8. Access through the resolver: every read path
9. Events
10. Gates
11. Order of wiring
12. Decisions taken for you
13. As built
14. Open questions

## 1. Goals and non-goals

**Goals:**
- **Share by category:** the patient shares prescriptions, labs, imaging, discharge summaries and/or uploads, optionally limited to a date range.
- **Requests:** a doctor or a facility asks for access; the patient approves (possibly narrower) or declines.
- **Sensitive categories hidden by default:** mental health, sexual health, HIV, substance use and reproductive health appear only with an explicit opt-in on that share.
- **The patient sees every access** (who opened what, when, by which way in) and can **revoke all** in one tap.
- **Honoured everywhere:** retrieval (the AI) and every read path, not only one screen.

**Non-goals:**
- No change to:
  - treating-hospital access (the care relationship);
  - break-glass;
  - the patient's own view.
- No ABDM consent-manager integration. The share's fields mirror ABDM (purpose, scope, recipient, period) so a later integration maps one to one (§12, decision 3).
- No proxy sharing: a household manager sharing for a member is 5b.

## 2. What a share covers

A **share** is the person's permission for one recipient to read part of their record for a purpose and a period.

| Field | Meaning |
|---|---|
| Recipient | The doctor who redeemed the code, or the doctor or facility whose request was approved |
| Categories | Any of `PRESCRIPTIONS`, `LABS`, `IMAGING`, `DISCHARGE_SUMMARIES`, `UPLOADS` (at least one) |
| Sensitive opt-ins | Any of the five sensitive categories; empty by default |
| Period | Optional `recordedFrom` / `recordedTo`: only entries recorded in that window |
| Records | The person's facility records the share covers: by default every `ACTIVE` link when the share is made, a snapshot. A record linked later isn't included |
| Purpose | `CONSULTATION`, `SECOND_OPINION`, `FOLLOW_UP`, `REFERRAL`, `OTHER` |
| Validity | From creation until `expiresAt`. A code share also ends when its visit ends |

**Always included: the safety minimum.** Every share also shows active allergies and the allergy status (ALLERGIES), with sensitive ones still filtered. A doctor who can prescribe must see allergies. This is a decision for the clinical advisor's sign-off (§14).

**Never included through a share:** clinical notes, diagnoses and the problem list, vitals and referrals. They aren't among the spec's five categories; adding a category is an open question (§14). The visit dates the share's entries came from are shown with those entries.

**Category mapping** (one table, `src/lib/sharing/categories.ts`, used by every read path):

| Share category | Facility record | Person-level |
|---|---|---|
| PRESCRIPTIONS | Medication orders, prescriptions | — |
| LABS | Released lab results | — |
| IMAGING | Verified imaging reports | — |
| DISCHARGE_SUMMARIES | Discharge summaries; clinical documents of discharge type | — |
| UPLOADS | — | The person's uploads (`PersonDocument`) and confirmed patient-provided entries. Each entry also needs its own category: an uploaded lab value needs LABS too, as in retrieval |
| (always) ALLERGIES | Active allergies, allergy status | Patient-provided allergies only with UPLOADS |

## 3. Data model

All new models are person-scoped (`PERSON_SCOPED_MODELS` in `src/lib/person/tenancy.ts`); none carries a facility tenant of its own. Migrations are additive, and nothing is backfilled or guessed (§4.3).

### 3.1 `RecordShare`

```prisma
model RecordShare {
  id                  String              @id @default(cuid())
  personId            String
  kind                RecordShareKind     // CODE | REQUEST
  status              RecordShareStatus   // PENDING | ACTIVE | ENDED | EXPIRED | REVOKED
  purpose             SharePurpose
  categories          ShareCategory[]     // at least one
  sensitiveCategories RagSensitiveCategory[] @default([])
  recordedFrom        DateTime?
  recordedTo          DateTime?
  patientIds          String[]            // the facility records covered (snapshot)
  // The recipient: a doctor (user) or a facility. A code share has neither until redeemed.
  recipientUserId     String?
  recipientFacilityId String?
  accessRequestId     String?             @unique
  expiresAt           DateTime
  createdByUserId     String
  createdAt           DateTime            @default(now())
  endedAt             DateTime?
  endedReason         ShareEndReason?     // VISIT_ENDED | EXPIRED | PATIENT_REVOKED | REVOKE_ALL | PERSON_CLOSED
  version             Int                 @default(1)
  @@index([personId, status])
  @@index([recipientUserId, status])
  @@index([recipientFacilityId, status])
}
```

`PatientAccessSession` gains `shareId String? @unique`, the share the code carries. A code issued before 4c has none and keeps its old behaviour (§4.3).

### 3.2 `AccessRequest`

```prisma
model AccessRequest {
  id                  String              @id @default(cuid())
  personId            String
  patientId           String              // the requester's facility record of this person
  requesterKind       AccessRequesterKind // DOCTOR | FACILITY
  requesterUserId     String              // who asked (for FACILITY: the staff member acting for it)
  requesterFacilityId String
  purpose             SharePurpose
  categories          ShareCategory[]
  recordedFrom        DateTime?
  recordedTo          DateTime?
  reason              String?             // ≤ 280 chars, shown to the person only
  status              AccessRequestStatus // REQUESTED | APPROVED | DECLINED | CANCELLED | EXPIRED
  expiresAt           DateTime            // undecided requests expire (7 days)
  decidedAt           DateTime?
  createdAt           DateTime            @default(now())
  version             Int                 @default(1)
  @@index([personId, status])
  @@index([requesterFacilityId, status])
}
```

### 3.3 The access log

`PersonAccessLogEntry` gains the kinds `SHARE_CREATED`, `SHARE_ENDED`, `ACCESS_REQUESTED`, `ACCESS_REQUEST_DECIDED` and `ACCESS_REVOKED_ALL`. `RECORD_ACCESSED` entries carry a structured `detail`:

```json
{ "via": "SHARE_CODE" | "ACCESS_REQUEST" | "TREATING" | "ORG_CONSENT" | "BREAK_GLASS",
  "shareId": "…?", "surface": "CONSULT_VIEW" | "AI_ASK" | "DOCUMENT_DOWNLOAD",
  "categories": ["LABS", …] }
```

The accessing facility and user are already columns.

## 4. The one-visit code, upgraded

### 4.1 Issuing

`POST /api/patient/access-session` takes the share's choices:
- `categories` (default: all four record categories, without UPLOADS);
- `sensitiveCategories` (default none);
- an optional period;
- `purpose`;
- `validHours` (1–24, default 24).

In one transaction it creates the `RecordShare` (PENDING, kind CODE) and the `PatientAccessSession` with `shareId`, emitting `RecordShareCreated` and writing `SHARE_CREATED` to the person's log. The plaintext code is still shown once and never stored.

The default leaves out UPLOADS, matching what the code shared before 4c. Only the patient's ticking adds them.

### 4.2 Redeeming and the visit

Redeeming binds the share to the doctor: `recipientUserId`, `recipientFacilityId`, ACTIVE, with `RecordShareStatusChanged` (PENDING → ACTIVE). This happens in the redemption transaction, beside the existing `PatientAccessSessionStatusChanged`.

The consult window (15 minutes, extendable) is unchanged, but an extension can never pass the share's `expiresAt`. When the visit ends (by the doctor, the patient or expiry), the share ends with it (`VISIT_ENDED` / `EXPIRED`). One code, one visit.

### 4.3 Codes issued before 4c

A session with no `shareId` was issued before 4c. It reads as before, under the 4b rules: the facility record, no uploads, no sensitive categories. It expires within 30 minutes of issue anyway. Nothing is backfilled. No share is invented for an old code.

## 5. Access requests

- **Who may ask:** a DOCTOR (as themselves) or a facility admin (as the facility) at a facility that holds an `ACTIVE` link to the person. A request is always about a patient the requester already knows; there is no search for people. A request about anyone else is a 404.
- **What the person sees:** who is asking (doctor's name, facility), the purpose, the categories and period asked for, and the reason. They can:
  - **approve as asked, or narrower:** fewer categories, a shorter period, sensitive opt-ins only if they tick them (a request can't ask for sensitive categories). Validity is 1–90 days, default 30. Approving creates the `RecordShare` (kind REQUEST, ACTIVE, bound to the requester) in the same transaction;
  - **decline.**
- **Requester's side:** the requester can cancel a pending request. Undecided requests expire after 7 days (a sweep in the runner tick, each with its event).
- **One open request per requester and person:** a second is refused while one is pending.
- **Who reads through an approved request:**
  - DOCTOR requester: that doctor only;
  - FACILITY requester: any doctor at that facility with an active care relationship with the person's record there.

## 6. Sensitive categories

The five categories are classified at indexing time (`sensitiveCategoryOf`, RAG §5.3). Every read path uses the same classifier on what it returns, so a screen and the AI agree.

- A share without opt-ins never returns a sensitive item. The item is absent: there's no "hidden" placeholder that would itself reveal something.
- Opt-ins are per share. A new share starts empty again.
- The patient's issue and approve screens list the five by name with a plain explanation, unticked.
- Treating-hospital access, break-glass and the patient's own view are unchanged (they see sensitive items, as today).

## 7. The access log and "revoke all"

### 7.1 The person's log

`GET /api/patient/person/access-log` returns the person's own entries, newest first, paged. Each entry shows:
- when;
- who (doctor or staff name, facility);
- what (the surface and categories);
- the way in (code, request, treating hospital, organization consent, break-glass).

Writing a `RECORD_ACCESSED` entry is part of the read (bookkeeping, not a state change).

**Which reads log an entry:**
- **One per consult view:** opening the consult view logs one entry. Its periodic refresh doesn't, so the log isn't flooded (the visit already logs).
- **One per AI request:** each AI request over a share or a care relationship that touches person-level data.
- **One per download:** each document download, as today.

### 7.2 Revoke all

`POST /api/patient/person/revoke-all` (`confirm: "REVOKE"`), in one transaction:

1. ends every PENDING or ACTIVE `RecordShare` (`REVOKE_ALL`), and with it every open `PatientAccessSession` of the person's records;
2. declines every pending `AccessRequest`;
3. revokes every `InteropConsent` the patient granted (`grantedBy = PATIENT`) on any linked record;
4. sets "share uploads with treating hospitals" to DECLINED if it was GRANTED.

Each of these emits its own event. Then it emits `PersonAccessRevokedAll` with the counts and logs `ACCESS_REVOKED_ALL`.

**Not affected:**
- **The treating hospital's own record** stays with the hospital; it is theirs.
- **Break-glass** isn't a grant.
- **Processing consents** (`DOCUMENT_PROCESSING`, `AI_ASSISTANCE`, `AI_TEXT_RETENTION`) aren't access and are untouched.

The screen says this before the tap.

**When a revoked share stops working:** at once, everywhere, because every read path checks the share's status on every request. The RAG index is not touched: shares are filters, not copies.

## 8. Access through the resolver: every read path

`src/lib/sharing/resolve.ts` is the one place a share becomes a scope:

```ts
shareGrant(actor: { userId; facilityId; role }, shareId): Promise<ShareScope | null>
// ShareScope: { shareId, personId, patientIds, categories, sensitive, recordedFrom?, recordedTo?, uploads: boolean, via }
```

It returns null unless all of these hold:
- the share is ACTIVE and not expired;
- the actor is its recipient (the doctor, or a doctor of the recipient facility with a care relationship);
- for a code share, its visit is still open.

`personAccess` gains a `SHARE` way in (`via: "SHARE"`) for UPLOADS through `shareGrant`.

| Read path | Today | With 4c |
|---|---|---|
| Consult view (`/api/hospital/patient-access/[id]`, `getSessionHistory`) | The whole record | `shareHistory(scope)`: only the share's categories, period and opt-ins, plus allergies; uploads and patient-provided entries only with UPLOADS. Codes issued before 4c keep the old view (§4.3) |
| AI (`/api/ai/ask`, SHARE path) | Facility record, no uploads, no sensitive; the period only from the request | Segments from the share: its categories (and ALLERGIES), its sensitive opt-ins, its period intersected with the request's, and a person segment (origins PATIENT_PROVIDED) only with UPLOADS. Requests carry `shareId` for a code or an approved request |
| Person document list and download (staff) | Care relationship + "share uploads" choice | Also through a share with UPLOADS, logged with `via` |
| Timeline and summary (staff) | Care relationship | Unchanged: a share isn't a care relationship |

**The single test of correctness** is the leak gate (§10): a canary per limit, never seen past it, and seen inside it (the positive control).

## 9. Events

All are PERSON scope, SENSITIVE, with ids and closed codes only (catalogue conventions, `.strict()` contracts, v1):

| Event | Aggregate | Payload |
|---|---|---|
| `RecordShareCreated` | RECORD_SHARE | `shareId, personId, kind, purpose, categories[], sensitiveCategories[], hasPeriod, expiresAt` |
| `RecordShareStatusChanged` | RECORD_SHARE | `shareId, personId, from, to, endedReason?` |
| `AccessRequested` | ACCESS_REQUEST | `requestId, personId, requesterKind, requesterFacilityId, purpose, categories[]` |
| `AccessRequestStatusChanged` | ACCESS_REQUEST | `requestId, personId, from, to, shareId?` |
| `PersonAccessRevokedAll` | PERSON | `personId, sharesEnded, requestsDeclined, consentsRevoked, uploadsSharingDeclined` |

**Consumers:**
- **`rag-indexer`:** none needed (shares are filters).
- **`task-generator`:** a notification to the person on `AccessRequested`, through the existing outbox, saying only that a request is waiting.

## 10. Gates

| Gate | Proves |
|---|---|
| `verify-postgres-record-sharing` | Categories: a LABS-only code shows labs and allergies and no prescriptions, imaging or discharge summaries, in the consult view and the AI. The period: entries outside it are absent. UPLOADS adds uploads and patient-provided entries, still per category. An expired or ended share reads nothing. A second doctor holding nothing sees nothing. A pre-4c code keeps its old view. Every transition emits its event |
| `verify-postgres-access-requests` | Only a doctor or admin at a linked facility can ask; others get a 404. Approve narrower: the share has the narrower scope. Decline, cancel and expiry. One open request per requester. FACILITY-recipient reads need a care relationship. Events |
| `verify-postgres-sensitive-categories` | An HIV result and a psychiatric diagnosis are absent from every path without an opt-in, present with the matching one, and still absent for the other categories |
| `verify-postgres-revoke-all` | After revoke-all, every share, session, pending request, patient-granted organization consent and the uploads choice is ended, with each event plus `PersonAccessRevokedAll`. Every path returns nothing at once. Treating access is unaffected |
| `verify-postgres-rag-leaks` (extended) | One canary per new limit (category, period, sensitive, uploads, revoked, other recipient), zero tolerance, each with its positive control |
| `verify-postgres-core-journey` (extended) | Patient issues a LABS-only code → doctor redeems → visit brief cites only labs → the person's log shows it → revoke all → nothing |

## 11. Order of wiring

Each step lands with its gate.

1. Models, enums and the migration (additive); tenancy lists; event contracts; exemptions for the log writes.
2. `src/lib/sharing`: categories and mapping, `shareGrant`, `shareHistory`, issue and redeem with shares, the expiry interplay.
3. The consult view and the AI SHARE path on `shareGrant`. The 4b stand-in is removed. Gate: record-sharing.
4. Sensitive filtering on every path. Gate: sensitive-categories.
5. Access requests: the service, routes, sweep and notification. Gate: access-requests.
6. Access log reads and revoke-all. Gate: revoke-all.
7. Leak canaries and the core-journey extension.
8. Screens:
   - the share page (categories, sensitive opt-ins, period, validity);
   - requests (approve narrower, decline);
   - the access log with "revoke all";
   - the doctor's request form.

## 12. Decisions taken for you

1. **A share is a new person-owned model, not an `InteropConsent` row.** Consents the patient gives belong to the Person (Phase 0). `InteropConsent` is facility-tenanted and keyed to one facility record, while a share can span the person's records. `InteropConsent` stays the interoperability artefact and the organization consent.
2. **The default code share is the four record categories without uploads, with no sensitive categories.** Uploads and sensitive categories are opt-in per share. The default matches what the code exposed before.
3. **ABDM shape:**
   - share fields map to an ABDM consent artefact: purpose (code), hiTypes (categories), requester (recipient), permission dateRange and expiry;
   - no ABDM call is made;
   - `CONSULTATION`, `SECOND_OPINION`, `REFERRAL` and `FOLLOW_UP` all map to ABDM `CAREMGT`;
   - `OTHER` maps to no ABDM purpose and would not be exported.
4. **Allergies ride with every share** (the safety minimum), with sensitive ones filtered. This awaits the clinical advisor.
5. **Notes, diagnoses, vitals and referrals are not shareable categories yet.** The spec names five categories.
6. **A share covers a snapshot of the person's linked records,** not records linked later.
7. **Code validity is 1–24 hours (default 24, per the spec), and the share ends with the visit.**
8. **Request validity is 1–90 days (default 30).** Undecided requests expire in 7 days. One open request per requester and person.
9. **Requests can't ask for sensitive categories;** only the person can add them when approving. `OTHER` purpose requests aren't accepted from facilities.
10. **Revoke all also declines "share uploads with treating hospitals" and revokes patient-granted organization consents.** It does not touch processing consents, the treating hospital's own record or break-glass.
11. **Consult-view refreshes don't log;** opening it does.
12. **No placeholder for withheld items:** absent, not "hidden".

## 13. As built (Week 4c, 2026-10-19)

**Code:**
- `src/lib/sharing/` holds the library:
  - `categories.ts` (the one mapping);
  - `shares.ts` (life of a share and the expiry sweep);
  - `resolve.ts` (`resolveShare`, the one place a share becomes a scope);
  - `history.ts` (`shareHistory`);
  - `view.ts`;
  - `requests.ts`;
  - `revokeAll.ts`;
  - `accessLog.ts`.
- Migration `20261023110000_record_sharing` is additive, with CHECKs for at least one category and a forward period, and a partial unique index for one open request per requester and person.
- Five events, v1, PERSON scope, SENSITIVE.
- Two runner sweeps: share expiry and request expiry.

**Routes:**
- **Patient:**
  - `POST /api/patient/access-session` (now with the share choice);
  - `/api/patient/person/shares` and `/shares/[id]/end`;
  - `/access-requests` and `/access-requests/[id]/decide`;
  - `/access-log`;
  - `/revoke-all`.
- **Staff:**
  - `/api/hospital/access-requests` (+ `/[id]/cancel`);
  - `/api/hospital/shares/[id]`;
  - the consult view `/api/hospital/patient-access/[id]` now scoped.

**Screens:**
- the patient's share page (choices, requests, shares, access log, revoke all);
- the doctor's consult view (only shared sections, with the AI panel);
- "Records from other hospitals" on the chart;
- the shared-record page for an approved request.

**Gates:**
- `verify-postgres-record-sharing` (27);
- `verify-postgres-access-requests` (33);
- `verify-postgres-sensitive-categories` (16);
- `verify-postgres-revoke-all` (18);
- `verify-postgres-rag-leaks` section 13 (16 new checks, each with its control);
- core journey (3 new checks).

**Departures from the text above:**
1. **Staff download of a person's document through a share is not wired.** The shared view lists the uploads' titles and their confirmed entries, but the staff download route still needs the care relationship and "share uploads" choice (§8 table). Recorded in the pre-launch checklist.
2. **The request notification is sent inline** (an email from `requestAccess`, after the commit) rather than through a `task-generator` consumer. It says only that a request is waiting.
3. **Codes issued before 4c read the default code scope in the consult view too.** That is narrower than what they showed before: no notes, diagnoses, vitals or encounters, and no sensitive items. `getSessionHistory` (the whole record) is removed.
4. **Allergies, the safety minimum, are not limited by a share's period.** They are current state. Sensitive ones are still filtered.
5. **The unredeemed code window stays 30 minutes.** A share's validity (1–24 hours, default 24) bounds the visit, and extensions never pass it.

**Also changed:**
- **Live facts in retrieval:** allergies are now sensitivity-filtered on every path, a no-op where every category is allowed. A share's period also limits live medicines.
- **Closing an account** ends the person's live shares (`PERSON_CLOSED`) and declines waiting requests. The purge deletes shares and requests.
- **A person merge** carries shares and requests over.
- **Two tx-level helpers were extracted** so revoke-all runs in one transaction: `recordPersonConsentTx` and `revokeConsentTx`.

## 14. Open questions

1. **Clinical advisor:**
   - Allergies as the safety minimum of every share (decision 4).
   - Whether diagnoses or the problem list should become a sixth category (decision 5).
   - The sensitive classifier's reach (`sensitiveCategoryOf` is a term list; real data needs a reviewed classifier).
2. **Code validity:** 24 hours is the spec. Is that right for a code that then lives only as long as one visit, or should the unredeemed window stay short (30 minutes today)?
3. **Facility-recipient requests:** should reading be limited to the doctor who asked unless the person ticks "the whole facility"?
4. **ABDM:** when the consent manager is integrated, does a share become an ABDM artefact, or does it stay local with a separate ABDM flow?
5. **Revoke all and organization consents** that staff recorded offline (`grantedBy = STAFF_RECORDED`): revoke them too, or leave them as the hospital's record of a paper consent?
6. **Notifications:** should the person be told each time someone opens their record (a push per access), or is the log enough?
