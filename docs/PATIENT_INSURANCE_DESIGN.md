# Patient insurance and no queues: design (5c)

- **Status:** Revision 1, 2026-10-19. A design only; nothing here is built until it is approved.
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
