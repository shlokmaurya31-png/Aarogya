# Patient insurance and no queues: design (5c)

- **Status:** Revision 2, 2026-10-24. Built in Week 5c on branch `foundation/w5c-insurance`; §14 records the decisions given with the task and where the code departs from this text.
- **Spec:** `docs/PRODUCT_SPEC.md` feature F (insurance and no queues).
- **Builds on:**
  - **Revenue cycle:** coverage (`PatientCoverage`, `Payer`, `PayerPlan`, `CoverageStatusChanged`), pre-authorization (`PreAuthorization`, `PreauthStatusChanged`, `PreauthDecided`) and claims (`Claim`, `ClaimSubmission`, `ClaimQuery`, `ClaimSettlement`, `ClaimStatusChanged`, `ClaimSubmitted`, `ClaimSettled`, `ClaimQueryStatusChanged`). See `docs/PHASE_5_REVENUE_CYCLE.md`.
  - **NHCX** (`NhcxExchange`): coverage eligibility, pre-auth, claim, communication, status and payment notice, with idempotent, correlated exchanges. Disabled until the network is wired.
  - **Queue and check-in:** `QueueEntry`, `checkInAppointment` (`PatientCheckedIn`), and the patient's `listQueuePositions`.
  - **Payments:** the patient payment boundary (`src/lib/patient/experience/payments.ts`). The amount is computed only on the server from the invoice; a payment is recorded only from a provider-verified callback. Today it returns `PROVIDER_NOT_CONFIGURED` honestly.
  - **The patient's insurance view** (`src/lib/patient/experience/insurance.ts`): canonical statuses in patient language, member ids masked.
  - **Consent sharing (4c):** `RecordShare`.
  - **Households (5b):** the `INSURANCE` and `BOOK` proxy permissions.
- **ADRs:**
  - 0003: adapters (the payment gateway, NHCX);
  - 0004: events in the writer's transaction.

## Contents

1. Goals and non-goals
2. Insurance cards
3. Pre-arrival check-in
4. Arrival and the queue token
5. Pre-authorization, cashless at discharge, claims
6. Paying the patient's share
7. Data model
8. Access through the resolvers
9. Events
10. Gates
11. Order of wiring
12. Decisions taken for you
13. Open questions

## 1. Goals and non-goals

**Goals:**
- **Insurance cards for each household member,** held by the person, never trusted by a facility until verified.
- **Pre-arrival check-in** for a booked appointment: a record share, an insurance card and a queue token, so the patient doesn't wait at the desk.
- **The patient sees:**
  - pre-authorization status;
  - cashless status at discharge;
  - their share to pay;
  - each claim's progress.

  All of it comes from canonical records only.
- **Paying their share in the app,** through the existing boundary once a gateway is configured.

**Non-goals:**
- **No insurer-side portal, and no claim adjudication.**
- **No estimated approvals.** No AI or rule ever predicts what an insurer will pay; the patient sees decided values only.
- **No new payment rails:** one gateway adapter, behind the existing boundary.

## 2. Insurance cards

**An `InsuranceCard` belongs to the member's Person:** patient-provided data, as an upload is. It holds:
- the payer (from the `Payer` list, or "other" with a name);
- the plan name;
- the member id and policy number (both encrypted at rest; shown masked to the last 4 except on the card's own edit screen);
- validity;
- photos of the card (front and back, stored like uploads, normalized like page images, with metadata stripped).

**Who adds a card:** the member, or a proxy with INSURANCE (5b).

**Facility trust:** a facility never treats a card as coverage on its own. At check-in or registration, staff verify it: by eligibility through NHCX when wired, or by the desk's existing manual check. Only then do they create or update the facility's `PatientCoverage`, with `sourceCardId` recorded. The card stays patient-provided; the coverage is the facility's verified record.

**Optional AI card reading** (photo to fields) goes through the document pipeline's OCR and extraction with the same consent rules. The person confirms each field, as for any extracted fact. It is off unless `DOCUMENT_PROCESSING` is granted.

## 3. Pre-arrival check-in

**When:** for an appointment that is BOOKED or CONFIRMED, from 24 hours before its start until 30 minutes after it. The patient, or a proxy with BOOK and INSURANCE, opens "Check in before you arrive" and sees four steps:

1. **Confirm details:** name, date of birth and phone, as on the facility record (read-only). Mismatches go to the desk; nothing is edited here.
2. **Share your record with the doctor (optional):** a 4c share of kind BOOKING if one isn't already attached (5a), or of kind CHECKIN. The categories and sensitive opt-ins are the patient's choice.
3. **Insurance (optional):** pick a card. It is shared with this facility for this visit only (a `CardShare`), so staff can verify it before the patient arrives. Choosing "I'll pay myself" is a valid answer.
4. **Submit:** creates the `PreArrivalCheckIn` (SUBMITTED) and emits `PreArrivalCheckInSubmitted`. The desk's list shows "pre-arrived: details confirmed, card to verify".

**Staff, before arrival:**
- verify the card (eligibility; the coverage created or updated);
- note anything needed at the desk.

The check-in moves to READY or NEEDS_DESK, with a reason code (card not verified, details mismatch, payment due before consultation).

## 4. Arrival and the queue token

- **Marking arrival:**
  - the patient taps "I'm here", which only counts within the facility's radius if the facility enables location, and the location isn't stored; or
  - the desk scans the patient's check-in QR.

  Either runs the existing `checkInAppointment`: `PatientCheckedIn` and a `QueueEntry` (OPD_DOCTOR, the appointment's doctor).
- **The queue token** is the queue entry's position, shown on the patient's queue screen (`listQueuePositions`), updating as the queue moves.
- **A READY check-in skips the registration desk:** the token goes straight to the doctor's queue.
- **A NEEDS_DESK check-in** gets a REGISTRATION queue token first, with the reason shown to the patient in plain words.
- **Lapsing:** a check-in whose patient doesn't arrive lapses with the appointment (no-show or cancelled), with its event.

## 5. Pre-authorization, cashless at discharge, claims

**What the patient sees** (a projection, `patientInsuranceStatus`): canonical values only, in patient language, with no internal notes.

| Stage | Source | Shown |
|---|---|---|
| Pre-authorization | `PreAuthorization` + NHCX PREAUTH exchanges | Requested, approved (amount), denied (with the payer's reason category), expired |
| Cashless at discharge | The final invoice, the approved pre-auth and the claim | "Cashless approved up to ₹X", "Your share: ₹Y" (non-payables, co-pay, over the approved amount), "Waiting for the insurer's final approval" |
| Claim | `Claim`, `ClaimSubmission`, `ClaimQuery`, `ClaimSettlement` | Drafted, submitted, under review, query (what's asked), approved or partially approved, rejected, settled (amount, date) |

- **The patient's share is computed only on the server:**
  - by the invoice's existing allocation logic: total minus insurer-approved, minus payments;
  - only when the invoice is final or the insurer has decided;
  - otherwise "not yet known".
- **Notifications:** a `patient-insurance-notify` consumer on `PreauthStatusChanged`, `PreauthDecided`, `ClaimStatusChanged`, `ClaimQueryStatusChanged`, `ClaimSettled` and `DischargeInitiated` tells the patient (and their INSURANCE proxies) that something changed. The message carries no amounts or diagnoses; they open the app to see them.
- **A claim query that needs a document:** the patient answers by attaching one of their uploads. This creates a `RecordShare` (kind CLAIM) for that facility, scoped to exactly those documents (`sourceIds`), for the claim's life. Staff then attach it to the submission.

## 6. Paying the patient's share

- **Same boundary as today:** the payment boundary stays exactly as built:
  - the server computes the amount;
  - the patient pays their own invoice only (or a proxy with INSURANCE pays for a member);
  - a payment is recorded only from the provider's verified callback.
- **The gateway** is an adapter (ADR 0003), Razorpay first. It is configured per environment, and the creds are an external blocker. Until it is configured, initiation returns `PROVIDER_NOT_CONFIGURED` and the screen says so honestly.
- **Events:** `PaymentReceived` / `PaymentFailed` / `HospitalPaymentRecorded` as today; no new payment events.

## 7. Data model

**Person-scoped:**

```prisma
model InsuranceCard {
  id              String   @id @default(cuid())
  personId        String
  payerId         String?
  payerName       String              // shown; from the Payer list or typed
  planName        String?
  memberIdCipher  String              // encrypted (the AI-text key scheme, its own key purpose)
  memberIdLast4   String
  policyCipher    String?
  validFrom       DateTime?
  validTo         DateTime?
  frontImageRef   String?
  backImageRef    String?
  status          InsuranceCardStatus // ACTIVE | REMOVED
  addedByPersonId String              // the member or their proxy
  version         Int      @default(1)
  createdAt       DateTime @default(now())
  @@index([personId, status])
}
model CardShare {   // a card shared with one facility for one visit
  id, cardId, personId, facilityId, appointmentId, status ACTIVE | ENDED, expiresAt, createdAt
}
```

**Facility-scoped:**

```prisma
model PreArrivalCheckIn {
  id, facilityId, appointmentId @unique, patientId, personId,
  status PreArrivalStatus   // SUBMITTED | READY | NEEDS_DESK | ARRIVED | LAPSED | CANCELLED
  needsDeskReason String?   // closed codes
  shareId String?, cardShareId String?, submittedByPersonId String, submittedAt, decidedByUserId?, version
}
```

**Changes to existing models:** `PatientCoverage` gains `sourceCardId String?` (additive). RecordShare kinds gain `CHECKIN` and `CLAIM` (4c's model).

## 8. Access through the resolvers

- **Cards:** `personAccess(actor, personId, "INSURANCE")`:
  - OWNER, or PROXY with INSURANCE (5b);
  - facility staff only through an ACTIVE `CardShare` for their facility, and only while it lasts (`cardShareGrant`).
  - Every staff read of a card is logged in the person's access log (`via: CARD_SHARE`).
- **Check-ins:** facility staff read them under the facility's tenancy, as appointments are. The patient side reads its own through `resolveReadScope` / the PROXY grant.
- **Insurance status projection:** the patient's own records (self scope) or an INSURANCE proxy. It never reaches another patient's coverage, by construction (`patientIds` from the scope).
- **Claim documents:** through a CLAIM `RecordShare` (4c's `shareGrant`).

## 9. Events

Catalogue conventions apply, v1.

| Event | Scope | Sensitivity | Payload |
|---|---|---|---|
| `InsuranceCardChanged` | PERSON | SENSITIVE | `cardId, personId, from, to` (ADDED / UPDATED / REMOVED; never the member id) |
| `CardShareStatusChanged` | PERSON | SENSITIVE | `cardShareId, cardId, personId, facilityId, from, to` |
| `PreArrivalCheckInSubmitted` | FACILITY | INTERNAL | `checkInId, appointmentId, patientId, hasShare, hasCard` |
| `PreArrivalCheckInStatusChanged` | FACILITY | INTERNAL | `checkInId, appointmentId, from, to, needsDeskReason?` |
| `CoverageVerifiedFromCard` | FACILITY | INTERNAL | `coverageId, patientId, cardShareId, method` (ELIGIBILITY / MANUAL) |

**Reused:**
- `PatientCheckedIn`;
- `CoverageStatusChanged`;
- the pre-auth, claim, discharge and payment events.

**Consumers:**
- `patient-insurance-notify` (above);
- `checkin-lifecycle`, which lapses check-ins on `AppointmentCancelled` and no-show.

## 10. Gates

| Gate | Proves |
|---|---|
| `verify-postgres-insurance-cards` | Cards are readable only by the owner, an INSURANCE proxy and a facility holding an ACTIVE card share (until it ends). Member ids are encrypted at rest and masked in every response. Card photos have no metadata. Events |
| `verify-postgres-pre-arrival` | The window opens 24 hours before and closes 30 minutes after. Submitting creates the check-in and the shares as chosen. Staff verification creates coverage with `sourceCardId`. READY goes straight to the doctor's queue; NEEDS_DESK gets a registration token. Cancellation or no-show lapses it. Every transition emits its event |
| `verify-postgres-patient-insurance-status` | Each stage shows only canonical values. The patient's share is "not yet known" until final. No amount appears in notifications. Another patient's coverage is unreachable (canaries) |
| `verify-postgres-patient-payments` (existing, extended) | Proxy payment within INSURANCE only. Still no success without a verified callback |
| Core journey (extended) | Book → pre-arrival check-in with a share and a card → staff verify → arrive → doctor's queue token → discharge → cashless status and the patient's share → pay (`PROVIDER_NOT_CONFIGURED` in CI) |

## 11. Order of wiring

1. Models, enums and the migration; tenancy; events; the card encryption key purpose.
2. Insurance cards (OWNER, then PROXY with 5b). Gate: insurance-cards.
3. Card shares and staff verification into `PatientCoverage`.
4. Pre-arrival check-in, the desk list, arrival and queue tokens. Gate: pre-arrival.
5. The patient insurance status projection and notifications. Gate: patient-insurance-status.
6. Claim-query document shares (4c CLAIM kind).
7. The payment gateway adapter, once creds exist; until then the boundary stays honest.
8. Screens and the core-journey extension.

## 12. Decisions taken for you

1. **A card is patient-provided and person-owned;** a facility's coverage is created only after staff verification, and records which card it came from.
2. **Member and policy numbers are encrypted at rest** and masked everywhere except the card's own edit screen.
3. **A card is shared with one facility for one visit,** never broadly.
4. **No predicted approvals or estimated shares.** "Not yet known" until canonical values exist.
5. **Notifications carry no amounts or clinical details.**
6. **Arrival by location is opt-in per facility, and the location isn't stored.** The QR at the desk always works.
7. **Pre-arrival check-in never edits the facility's demographics;** mismatches go to the desk.
8. **Card reading by AI** is optional, uses the document pipeline's consent and confirmation rules, and is off without `DOCUMENT_PROCESSING`.

## 13. Open questions

1. **NHCX go-live:** when eligibility checks are wired, should a READY status require an eligibility response, or is manual verification still accepted?
2. **Payment gateway:** Razorpay creds and the settlement account per facility. Which entity is the merchant (Aarogya or each facility)?
3. **Pre-arrival window:** 24 hours before and 30 minutes after, or per facility?
4. **Government schemes (PM-JAY, state schemes):** should the scheme ID be a card type with its own verification path?
5. **Claim queries:** may the patient answer queries directly (text), or only by attaching documents through the facility?
6. **Co-pay and non-payables:** should the patient see the line items behind their share, and from which codes?

## 14. As built (Week 5c, 2026-10-24)

Where this section and §1–§13 differ, this section holds.

### 14.1 Decisions given with the task

| Topic | As built |
|---|---|
| Cards | Per household member (the member, or a proxy with INSURANCE): payer type (`PRIVATE_INSURER`, `CORPORATE`, `GOVERNMENT_SCHEME` with a scheme code: `PM_JAY`, `CGHS`, `ESIC`, `STATE_SCHEME`), insurer, plan, member and policy numbers (AES-256-GCM under `INSURANCE_CARD_KEY_<v>`; no key, no card), validity, photos. Photos are re-encoded as JPEG (no EXIF) and stored in the uploads bucket, never as a `PersonDocument`, so the document pipeline never reads them; there is no AI card reading. |
| PM-JAY | A payer type, verified at the desk (manual) for now. |
| Pre-arrival window | From 24 hours before a booked visit (REQUESTED, CONFIRMED, RESCHEDULED) or a planned admission (`AdmissionRequest.plannedAdmissionAt`, PENDING or BED_RESERVED) until **1 hour before** (§3's "30 minutes after" is replaced). |
| Check-in | Confirm the facility's details (read-only; "something is wrong" sends the patient to the desk), an optional CHECKIN share for the visit's doctor (the admitting doctor for an admission; a directory booking's share is reused), a card (a `CardShare` for this facility until 2 days after the visit) or "I'll pay myself", and a token (`P-001`… per facility and visit day). The desk sees the patient pre-registered. |
| Eligibility | **Never waited for.** A card's check-in shows "eligibility pending" until staff verify it (manual now; `ELIGIBILITY` is reserved for NHCX); the desk can mark READY and the patient arrive meanwhile. Verification creates (or reuses) the facility's `PatientCoverage` with `sourceCardId`. |
| Patient views | Pre-authorization, cashless at discharge, the itemised bill, the patient's share, and the claim from submitted through under review and decided to settled, in plain words; notifications (`INSURANCE_UPDATE`, `BILL_READY`, `DOCUMENTS_REQUESTED`, `CHECKIN_OPEN`) to the patient and their INSURANCE proxies, with no amount, diagnosis or name. |
| Pay your share | To the **hospital's own** gateway account (`FacilityPaymentGateway`, Razorpay, per facility, TEST mode only). Only the public key id is stored; the secrets come from the environment under the facility's `secretRef`. The amount is the server's share; the payment is recorded only from the facility's verified webhook (`payment.captured`, the exact amount), allocated to the invoice. |
| Claim queries | Patients never answer the insurer. The hospital asks (`ClaimDocumentRequest`, plain words); the patient attaches uploads: a CLAIM share of exactly those documents for the facility's billing staff. |

### 14.2 Code

- `src/lib/insurance/`: `vocab.ts`, `cardCrypto.ts`, `cards.ts`, `cardShares.ts` (card shares, the desk's verification), `checkin.ts` (the window, submitting, the desk, arrival, `checkin-lifecycle`, the stale sweep), `status.ts` (the projection and `patientShare`), `claimDocuments.ts` (requests, attaching, `claim-documents-lifecycle`), `notify.ts` (`patient-insurance-notify`, the check-in-open sweep), `hospitalPayments.ts` (the gateway, orders, the webhook).
- `personAccess`: purpose `INSURANCE`; a `CARD_SHARE` way in (one card, one facility, while the card share lasts); a PROXY reaches cards only with INSURANCE.
- Share resolution: CHECKIN (the named doctor at that facility, while the check-in is open) and CLAIM (the facility's billing staff or admins, exactly `documentIds`; never a record view, never the AI).
- Migration `20261028100000_patient_insurance` (additive).
- Events: `InsuranceCardChanged`, `CardShareStatusChanged` (PERSON); `PreArrivalCheckInSubmitted`, `PreArrivalCheckInStatusChanged`, `CoverageVerifiedFromCard`, `ClaimDocumentRequestChanged`, `FacilityPaymentGatewayChanged`, `PatientPaymentOrderChanged` (FACILITY); `RecordShareCreated` v3 and `RecordShareStatusChanged` v3 (the CHECKIN and CLAIM kinds, their end reasons; v1 and v2 kept); `PersonNotificationQueued` v3 (the new kinds).
- Routes: `/api/patient/insurance/{cards,status,pay,orders,claim-documents}`, `/api/patient/checkin`; `/api/hospital/checkins`, `/api/hospital/claims/[id]/document-requests`, `/api/hospital/claim-document-requests/[id]`, `/api/hospital/payment-gateway`; the webhook `/api/payments/hospital/[facilityId]/webhook`.
- Screens: `/patient/insurance` (cards, visits and bills, pay, claim progress, documents asked), `/patient/checkin`, a "Check in" link on upcoming appointments; the front desk's "Pre-registered today"; claim documents on the claims worklist; the gateway on billing settings.
- Runner: card-share expiry, stale check-ins, "check-in is open".

### 14.3 Departures

1. **The token is issued at check-in; the queue entry on arrival.** The desk marks arrival (the existing `checkInAppointment`, then the doctor's queue when READY, registration otherwise). "I'm here" by location (§4) isn't built.
2. **The patient's share before the claim is decided** uses the insurer's cashless approval (an approved pre-authorization), labelled "final once the claim is decided"; with neither, it is "not yet known". A bill counts as self-pay only with no claim, no pre-authorization and no active coverage at the facility.
3. **Claim documents are hospital requests,** not NHCX `ClaimQuery` answers; ID proofs are never attached this way (shown at the desk), and a document that looks sensitive needs the patient's confirmation.
4. **No Razorpay test account was used** (that needs credentials): the Razorpay calls are the existing adapter's, exercised on an injected transport in the gates; the browser smoke stubs order creation only (`HOSPITAL_GATEWAY_STUB=1`, refused on a production deployment) and pays through a webhook signed with the run's secret.
5. **Event payload keys avoid "card"** (`insuranceId`, `insuranceShareId`, `hasInsurance`): the sensitive-key guard forbids any key containing it (payment cards), and was not weakened.
6. **A planned admission's check-in ends at arrival**; the admission continues at the admission desk.
7. **Proxies:** BOOK checks a member in; attaching a card also needs INSURANCE, and a share needs SHARE.

### 14.4 Gates

| Gate | Checks |
|---|---|
| `verify-postgres-insurance-cards` | 28: no key, no card; encrypted and masked; edit screen only; payer types and PM-JAY; EXIF stripped, not a PersonDocument; owner, INSURANCE proxy, no other proxy, nobody else; staff only through an active card share of their facility (logged); removing ends card shares; no number in any event |
| `verify-postgres-pre-arrival` | 33: the window; submitting (details, card share, CHECKIN share, token, events); once per visit; the desk list; READY without eligibility; verification into coverage (`sourceCardId`); arrival queues; NEEDS_DESK paths; lapsing on cancel, no-show and the sweep; cancelling; proxies; a planned admission; "check-in is open" once |
| `verify-postgres-patient-insurance-status` | 28: self-pay; the stages (pre-auth, cashless, bill, claim steps, the share recomputed); "not yet known"; claim documents (exact documents, no ID proofs, sensitive confirmed, no record view, no AI, no doctor, no other facility, ending at settlement); notifications without amounts, once each, to INSURANCE proxies; canaries; a proxy without INSURANCE |
| `verify-postgres-hospital-payments` | 25: not configured; TEST only, secrets only in the environment, admins only; the server's amount with the hospital's own key; 404s and proxies; wrong signatures, another facility's secret, wrong amount, unknown order and replays change nothing; the verified webhook records and allocates; payment.failed; the stub refused in production; no secret in audits |
| Core journey | The knee patient: card → pre-arrival check-in → desk verifies → doctor's queue → planned knee replacement (pre-auth approved) → discharge → itemised bill and share → the hospital asks for the MRI and the patient attaches it → pay the share (verified webhook) → claim settled, the document share ended |
| Browser smoke (`e2e/insurance.spec.ts`) | Add a card → pre-arrival check-in with it (token, eligibility pending) → the desk sees them pre-registered, verifies the card, ready, arrived → discharge → the itemised bill and the share → pay the share in test mode → the claim settled |
