# Cashless insurance through NHCX: design

- **Status:** Revision 1, 2026-11-10 (Flagship 5, step 4). Phase 1, behind a mock NHCX adapter, is built in step 5; §15 records what was built and where it departs from this text.
- **Spec:** `docs/PRODUCT_SPEC.md` feature F ("insurance should need no queues").
- **Builds on:**
  - **Insurance cards, card shares, pre-arrival check-in, the patient's insurance status, claim documents and paying the share** (Week 5c): `docs/PATIENT_INSURANCE_DESIGN.md`.
  - **The revenue cycle:** `PatientCoverage`, `PreAuthorization`, `Claim`, `ClaimSubmission`, `ClaimQuery`, `ClaimSettlement` and their events (`docs/PHASE_5_REVENUE_CYCLE.md`).
  - **The NHCX boundary** (Phase C5): `src/lib/hospital/nhcx/`: `NhcxExchange` (idempotent, correlated), `NhcxCallbackEvent` (the replay ledger), the FHIR collection-bundle mapper and the claim package. Transport is `NOT_IMPLEMENTED` on purpose: no official specification was readable then.
  - **Consent sharing** (4c): `RecordShare`, including the CLAIM kind (exactly the documents named).
  - **Households** (5b): the INSURANCE proxy permission.
  - **The adapter pattern with a mock:** Scan and Share (`docs/ABDM_CERTIFICATION_PLAN.md` §8): only the mock exists until the official specification has been checked field by field.
- **ADRs:** 0003 (adapters for external services), 0004 (events in the writer's transaction).

## Contents

1. Goals and non-goals
2. NHCX: what we know, and what is to confirm
3. The journey
4. Mapping to what exists
5. The consent model
6. What the hospital desk sees, and what the patient sees
7. Data model
8. Access
9. Events
10. The adapter
11. Failure modes
12. Gates and the journey
13. Phases
14. Open questions
15. As built (phase 1)

## 1. Goals and non-goals

**Goals:**
- **Cashless without queues.** At admission the hospital asks the insurer to pay directly; the patient follows it in the app instead of at the TPA desk.
- **The route is India's National Health Claims Exchange (NHCX)**, run by the National Health Authority under ABDM, between the hospital (the provider) and the insurer or TPA (the payer).
- **Every step through one exchange:** coverage eligibility, pre-authorisation at admission, enhancements, the discharge claim, the query and response loop, and the settlement status.
- **The patient approves what leaves.** Only the documents the request needs, chosen by the hospital and approved by the patient (or a household member with INSURANCE for them).
- **Both sides see the same state:** the hospital desk's queue and the patient's status screen are projections of the same records.

**Non-goals:**
- **No adjudication** and no insurer-side portal.
- **No predicted approvals.** The patient sees what the insurer decided; the only estimate shown is the hospital's own, labelled as such.
- **No real exchange in this flagship.** Phase 1 runs on a mock adapter (§10); the real adapter waits for the official specification and onboarding (§2).
- **Reimbursement claims** (the patient paid and claims afterwards) are out of scope here.

## 2. NHCX: what we know, and what is to confirm

**Rule: no adapter code against a guessed contract.** The Phase C5 boundary returns `NOT_IMPLEMENTED` because the protocol specification could not be read from a primary source, and that rule stands. Before any real adapter, the official NHCX specification (the NHA's published protocol and the FHIR implementation guide for claims, at the version the sandbox runs) is checked item by item, and the result is written into this section.

| Topic | What this design assumes | Status |
|---|---|---|
| Who runs it | NHCX is operated by the National Health Authority as part of ABDM; hospitals and payers join as participants with participant codes | Publicly announced; **details to confirm** (onboarding steps, environments) |
| Protocol | Built on the open Health Claims Exchange (HCX) protocol: asynchronous request and callback, encrypted payloads, participant registry | **To confirm** against the official protocol version |
| Message content | FHIR R4 resources under an India-specific implementation guide: an eligibility request and response, a claim used as a pre-authorisation or a claim, a claim response, communication requests for queries, and payment notices | **To confirm**: the resource names, profiles and required elements |
| Operations | Eligibility check, pre-authorisation (and enhancements as further pre-authorisation requests), claim submission, communication (query and answer), status check, payment notice | **To confirm**: the operation list, and whether an enhancement is its own operation |
| Identifiers | Correlation ids per exchange; the insurer's own reference returned in responses | **To confirm**: the header and field names |
| Decisions | Approved, partially approved, query, rejected | **To confirm**: the real code set, and how a partial approval and its reasons are expressed |
| Settlement | A payment notice when the insurer pays the hospital | **To confirm**: what it carries, and whether the patient's deductions are itemised |
| Documents | Attached to the request, or sent in answer to a query | **To confirm**: inline or by reference, allowed types, size limits |
| Security | Payload encryption and signatures between participants | **To confirm**: algorithms, key exchange, certificate handling |
| Time limits | Insurers answer a cashless request within regulator-set times | **To confirm**: the times that apply, from IRDAI's current circular, not from memory |

Nothing in phase 1 depends on any "to confirm" item: the hospital and patient sides speak to an interface (§10) in our own terms, and the mock implements it.

## 3. The journey

1. **Check-in: eligibility.** The patient's insurance card (shared for the visit, 5c) is checked with the insurer through the exchange. "Eligible" verifies the card into the facility's `PatientCoverage` (method ELIGIBILITY, which 5c reserved). "Not eligible" or no answer leaves the desk's manual check, as today. Eligibility is never waited for (5c's rule): the patient is admitted either way.
2. **Admission: the pre-authorisation request.** The billing desk builds it from the admission: the admitting diagnosis, the planned procedure, the expected stay and the hospital's estimate. The desk proposes the documents the insurer needs.
3. **The patient approves the documents.** In the app, the patient (or a household member with INSURANCE) sees each proposed document and approves the ones that go. Nothing is sent before that. The patient can remove any document; the desk is told and may ask again with a reason.
4. **Sent.** The request goes through the adapter with exactly the approved documents.
5. **The insurer answers:**
   - **approved:** an amount;
   - **partially approved:** a lower amount, with the insurer's reason category;
   - **query:** a question, sometimes asking for more documents;
   - **rejected:** with the insurer's reason category.
6. **The query and response loop.** The desk answers the query. If more documents are needed, the patient approves them first (step 3 again). The answer goes back through the exchange, and the insurer decides again. A query can come more than once.
7. **Enhancements.** If the stay or the procedure changes, the desk sends an enhancement: a further request for the same admission with the new estimate. The same approval, query and decision rules apply (phase 2).
8. **Discharge: the claim.** At discharge, the final bill becomes the claim (the existing `Claim`), sent through the exchange with the approved pre-authorisation's reference (phase 2).
9. **Settlement.** The insurer's payment notice settles the claim (`ClaimSettlement`), and both sides see it (phase 2).

## 4. Mapping to what exists

| Need | What exists | What this adds |
|---|---|---|
| The patient's insurance | `InsuranceCard` (person-owned, encrypted member id), `CardShare` for one facility and visit, `verifyCheckInCard` into `PatientCoverage` with `sourceCardId` | An eligibility check through the adapter that verifies the card (method ELIGIBILITY) |
| The admission | `Encounter` (IPD), `AdmissionRequest` (reason, expected stay), `Diagnosis` | The pre-authorisation request reads them; nothing about the admission changes |
| Pre-authorisation | `PreAuthorization` (REQUESTED / APPROVED / DENIED / EXPIRED; requested and approved amounts), `requestPreAuth` and `decidePreAuth` with `PreauthStatusChanged` and `PreauthDecided` | A `CashlessRequest` that carries the exchange's steps (documents to approve, query, partial) and writes the canonical `PreAuthorization` through the existing functions, so the patient's insurance status (5c) and the discharge rules keep working |
| The exchange | `NhcxExchange` (correlation, idempotency), `NhcxCallbackEvent` (replay guard) | Phase 1 uses its own ledger of insurer responses with the same rule (one row per external message id); the real adapter will record its exchanges in `NhcxExchange` |
| Documents | The patient's uploads (`PersonDocument`), CLAIM shares of exactly named documents, the hospital's own records | A proposed set per request, each approved or removed by the patient; facility documents approved the same way |
| Billing | `Invoice`, `Claim` at discharge, `patientShare` | Phase 2: the claim carries the pre-authorisation reference |
| Households | ProxyGrant with INSURANCE; `notifyPersonAndProxiesTx` | A proxy with INSURANCE follows the request and approves documents for the member |
| Notifications | `INSURANCE_UPDATE`, `DOCUMENTS_REQUESTED` (no amounts, no diagnosis) | Reused |

## 5. The consent model

- **Minimum necessary.** The desk proposes only what the insurer needs for this request (for example the admission note, the investigation that supports the diagnosis, the estimate). A document is never added "in case".
- **The patient approves each document** before anything is sent: approve, or remove. Removing one is not refusing the claim. The approval names the request, the documents and who approved (the patient, or which proxy).
- **ID proofs never go this way** (5c's rule). A document that looks sensitive (HIV, mental health, the sensitive list) needs the patient's explicit confirmation, as for claim documents in 5c.
- **Approved once, for this request.** A later query that needs more documents asks again. Approval doesn't open the record: the insurer gets exactly the approved documents, through the request.
- **Who may approve:** the patient; a household proxy with INSURANCE for that member (5b); a guardian for a child. Every proxy approval is in the member's access log.
- **What leaves the hospital** is recorded per request: which documents, when, through which exchange message.
- **DPDP:** the purpose is the patient's own claim, and the approval is per document. The notice text needs the lawyer's review (checklist item 4).

## 6. What the hospital desk sees, and what the patient sees

| | The hospital desk (billing, the facility's staff) | The patient (and their INSURANCE proxies) |
|---|---|---|
| Eligibility | The insurer's answer and the plan | "Your insurance is active for this stay", or "The hospital will check your insurance at the desk" |
| Request | Diagnosis, procedure, estimate, documents and their approval state, the exchange's correlation | "The hospital has asked your insurer to pay directly" |
| Documents | Proposed / approved / removed per document | Each document to approve, in plain words |
| Query | The insurer's question (untrusted text, shown as such), the answer box, documents to propose | "Your insurer asked the hospital a question. The hospital is answering." If documents are needed: approve them |
| Decision | Amount approved, the reason category for partial or rejected | "Approved ₹X. Your share: ₹Y, based on the hospital's estimate of ₹Z; the final bill is at discharge." Rejected: "Your insurer did not approve cashless for this stay," with the reason in plain words and what happens next |
| Settlement | The payment notice and reconciliation | "Settled" (phase 2) |

Never shown to the patient: internal notes, the insurer's free text, the exchange's identifiers. Never in a notification: amounts, diagnoses, names.

## 7. Data model

**Facility-scoped**, naming the patient (`FACILITY_MODELS_WITH_PERSON` where a person is named):

```prisma
model CashlessRequest {   // one per admission and coverage (enhancements later: kind ENHANCEMENT)
  id, facilityId, patientId, encounterId, coverageId, preAuthorizationId?
  kind              CashlessRequestKind     // PREAUTH (phase 1) | ENHANCEMENT (phase 2)
  status            CashlessStatus          // DRAFT | AWAITING_PATIENT | SUBMITTED | QUERY | APPROVED | PARTIAL | REJECTED | CANCELLED
  diagnosis, plannedProcedure (text, from the admission, editable by the desk), estimateMinor
  approvedAmountMinor?, decisionReason? (closed codes), queryText? (the insurer's, untrusted), queryAnswer?
  correlationId (server-made), submittedAt?, decidedAt?, version
}
model CashlessDocument {   // what the desk proposes; the patient approves or removes
  id, requestId, facilityId, source (PATIENT_UPLOAD | FACILITY_RECORD), refId, title
  status (PROPOSED | APPROVED | REMOVED), decidedByUserId?, decidedVia (OWNER | PROXY)?, decidedAt?, sentAt?
}
model CashlessInsurerMessage {   // each insurer response, once: the unique key is the replay guard
  id, facilityId, requestId, externalMessageId, decision, receivedAt
  @@unique([facilityId, externalMessageId])
}
model CashlessEligibility {   // each eligibility check from a card at check-in
  id, facilityId, checkInId, coverageId?, result (ELIGIBLE | NOT_ELIGIBLE | NO_ANSWER), checkedAt
}
```

Amounts are in paise (`*Minor`), as everywhere in billing.

## 8. Access

- **The desk:** facility staff with the billing permissions (`billing:claims`), under the facility's tenancy. Another facility's id is a 404, and the tenancy sweep probes every new route.
- **The patient side:** `personAccess(actor, personId, "INSURANCE")`: the OWNER, or a PROXY with INSURANCE for that member. Everyone else gets a 404, including a proxy without INSURANCE and another household's proxy. Proxy reads and approvals go to the member's access log.
- **Documents:** the patient approves their own uploads (person-owned) and the facility's own records proposed for this request. Approval never gives the desk access to anything else of the person's.
- **Another hospital** never sees the request, its documents or its decision.

## 9. Events

Catalogue conventions apply (ids and closed codes only, no amounts the guard forbids, no text).

| Event | Scope | Payload |
|---|---|---|
| `CashlessEligibilityChecked` | FACILITY | `eligibilityId, checkInId, patientId, result` |
| `CashlessRequestStatusChanged` | FACILITY | `requestId, encounterId, patientId, from, to, kind` (and `decisionReason` when decided) |
| `CashlessDocumentDecided` | FACILITY | `requestId, documentId, patientId, to` (APPROVED / REMOVED), `via` (OWNER / PROXY) |

Reused: `PreauthStatusChanged` and `PreauthDecided` (the canonical pre-authorisation), `CoverageVerifiedFromCard`, `PersonNotificationQueued`. The existing `patient-insurance-notify` consumer tells the patient and their INSURANCE proxies.

## 10. The adapter

```ts
interface CashlessExchange {
  readonly mode: "MOCK";
  checkEligibility(input: { correlationId; payerId; memberIdLast4 }): Promise<{ result: "ELIGIBLE" | "NOT_ELIGIBLE" }>;
  submitPreAuth(input: { correlationId; requestId; estimateMinor; diagnosis; plannedProcedure; documents: { id; title }[] }): Promise<{ accepted: true }>;
  answerQuery(input: { correlationId; answer; documents }): Promise<{ accepted: true }>;
}
```

- **Insurer responses arrive as messages** (`receiveInsurerResponse`), each with its own external id. In the real adapter they are the exchange's callbacks; in the mock they are injected by the gates, the browser journey's hospital step, and (in development only) a "mock insurer" control. Each message is recorded once (`CashlessInsurerMessage`); a replay is a no-op.
- **Only the mock exists:** `NHCX_CASHLESS_MODE` other than `mock` is refused, as Scan and Share refuses its other modes. The real adapter is written after §2's checks, and the hospital and patient sides don't change.
- **The mock never makes a network call**, and keeps what it was sent (for the gates: exactly the approved documents).

## 11. Failure modes

| What goes wrong | What happens |
|---|---|
| The exchange is unreachable at submission | The request stays SUBMITTED with the exchange's retry (the `NhcxExchange` retry policy, in the real adapter); the desk sees "not yet delivered". The patient sees "sent". Nothing is lost or sent twice (idempotency key per request and attempt) |
| The insurer doesn't answer in time | The desk's queue shows the time waited against the regulator's limit (**to confirm**); the desk escalates by phone as today. The patient sees "waiting for your insurer" |
| A response arrives twice | Recorded once; the second is a no-op (the unique external message id) |
| A response for a request that has moved on (cancelled, already decided) | Refused and recorded as a conflict for the desk; state doesn't change |
| A response from another facility's request | Not found (the correlation resolves within the facility only) |
| The patient doesn't approve the documents | The request waits in AWAITING_PATIENT; the desk can call the patient or cancel and proceed as self-pay. Nothing is sent |
| The patient removes a document the insurer needs | The desk is told; it can propose it again with a reason, or send without it |
| Partial approval | The patient sees the approved amount and their larger share, and can talk to the desk before treatment continues |
| Rejection | The admission continues; the patient is told plainly and the bill is self-pay unless an appeal or a new request succeeds |
| Coverage expired between eligibility and request | The request is refused at submission (coverage not ACTIVE) |
| The patient's share changes (enhancement, final bill) | Recomputed from the latest decided amounts; labelled final only at discharge |

## 12. Gates and the journey

| Gate | Proves |
|---|---|
| `verify-postgres-cashless-claims` | Eligibility from a shared card verifies coverage; a request is built from the admission; nothing is sent while a proposed document is unapproved; the mock received exactly the approved documents; approved, partial, query and rejected each drive the desk queue and the patient's status; the query and answer loop; a replayed insurer response is a no-op; a proxy can act only with INSURANCE for that member; another hospital can't see the request (404 on every route); every state change has its catalogued event in the same transaction; no amount or text in any event or notification |
| Browser journey (`e2e/cashless.spec.ts`) | Admit, pre-auth request, the patient approves documents, a query, the desk answers, approval, the patient sees "Approved ₹X; your share ₹Y" |

## 13. Phases

1. **Phase 1 (Flagship 5, step 5), mock adapter:** eligibility at check-in; the pre-authorisation request from the admission with the patient's approval of documents; mock insurer responses (approved, partial, query, rejected) driving the desk queue and the patient's status; household proxies; the gate and the journey.
2. **Phase 2:** enhancements; the discharge claim through the exchange with the pre-authorisation's reference; settlement from payment notices; time-limit tracking against the regulator's limits.
3. **Phase 3:** the real NHCX adapter, after §2 is checked and the hospital is onboarded as a participant, in the sandbox first.

## 14. Open questions

1. **The specification:** every "to confirm" row of §2, from the official NHCX specification and the claims FHIR implementation guide, at the sandbox's version.
2. **Participant onboarding:** is each hospital its own NHCX participant, or can Aarogya participate on a hospital's behalf (as a technology service provider)? This decides whose keys sign the messages.
3. **Which documents insurers need** for common admissions (medical and surgical), so the desk's proposal can start from a list rather than a blank, and whether that list needs the clinical advisor.
4. **The patient's share before discharge:** showing "your share ₹Y" from the hospital's estimate risks being read as final. Is the label enough, or should it show only after discharge?
5. **Time limits:** which regulator limits apply to cashless decisions and to discharge approvals today, and what the hospital must do when one is missed.
6. **The query text:** may the patient see the insurer's own words, or only the hospital's plain-language summary? Phase 1 shows the patient only that a question was asked.
7. **Government schemes (PM-JAY):** do they go through NHCX the same way, or through the scheme's own system?
8. **Rejections:** should the app show the patient how to appeal, or is that the hospital's conversation?
9. **Proxies:** may a proxy approve a sensitive document for an adult member, or only the member themself?
