# Households: design (5b)

- **Status:** Revision 2, 2026-10-20. Built in Week 5b on branch `foundation/w5b-households`; §14 records the answers given with the task and where the code departs from this text.
- **Spec:** `docs/PRODUCT_SPEC.md` feature D (household accounts), principle 7 ("one person, one record"), and the guardrail on children.
- **Builds on:**
  - **Person identity** (`docs/PERSON_IDENTITY_DESIGN.md`):
    - the `Person` owns uploads, patient-provided facts and patient-given consents;
    - `personAccess` reserves a `PROXY` way in for 5b (§8.2: "a proxy sees what their permissions and categories allow");
    - existing `PatientDelegation` rows stay facility delegations until 5b (§10.2).
  - **Family delegation** (`PatientDelegation`, `PatientDelegationScope`, `src/lib/patient/experience/family.ts`):
    - an invited user reads bounded surfaces of one facility record (APPOINTMENTS, RECORDS, REPORTS, …);
    - read-only; INVITED → ACTIVE → REVOKED or EXPIRED.
  - **Patient-given consents** (`PersonConsent`): decisions made by a guardian lapse at 18 (`LAPSED`, Week 4b).
  - **The `PROXY` document viewer** (Week 4c): a delegate's view carries none of the person's own uploads or entries until this design defines proxy permissions.
  - **Consent sharing (4c):** categories and sensitive opt-ins.
  - **RAG:** proxies are refused today; `USE_AI` arrives here.

## Contents

1. Goals and non-goals
2. Who is who
3. Data model
4. Member types and their lifecycles
5. Proxy permissions and categories
6. Coming of age
7. Access through the resolver
8. Existing family delegations
9. Events
10. Gates
11. Order of wiring
12. Decisions taken for you
13. Open questions
14. As built (Week 5b)

## 1. Goals and non-goals

**Goals:**
- **One account, many members:** a household of up to 8 member profiles (configurable) under one or more managers, with a profile switcher.
- **Every member stays their own patient,** with their own Person, record and consents. Ownership never transfers.
- **Separate permissions per proxy:** view, upload, book, share, insurance, use the AI.
- **Adults stay in control:** they always see who their proxies are and can remove them.
- **Sensitive categories are hidden from proxies** unless the member allows them.
- **Coming of age:** at 18 a managed minor's profile becomes their own, and they choose whether their parents keep access.

**Non-goals:**
- Joint records or shared profiles: never (principle 7).
- Facility-side "next of kin" or legal-representative records: these stay the facility's own data.
- Proxy break-glass: none. A proxy never gets more than the member gave.

## 2. Who is who

| Term | Meaning |
|---|---|
| **Member** | A Person in the household. Each has their own `Person`, record and consents |
| **Manager** | A member (an adult with their own login) who manages the household: adds or removes profiles and switches between them |
| **Proxy** | Anyone acting for a member, through a `ProxyGrant` that names their permissions and categories. A manager is usually a proxy for the members they manage, but holds no rights without a grant |
| **Grant basis** | Why the proxy may act: `GUARDIAN` (a parent or legal guardian of a minor), `RECORDED_CONSENT` (a dependent adult's recorded consent), `MEMBER_CHOICE` (an adult member chose it) |

## 3. Data model

All models are person-scoped (`PERSON_SCOPED_MODELS`). Migrations are additive.

```prisma
model Household {
  id              String   @id @default(cuid())
  name            String
  createdByPersonId String
  status          HouseholdStatus @default(ACTIVE)   // ACTIVE | CLOSED
  version         Int      @default(1)
  createdAt       DateTime @default(now())
}
model HouseholdMember {
  id           String   @id @default(cuid())
  householdId  String
  personId     String
  memberType   HouseholdMemberType   // SELF | MANAGED_MINOR | DEPENDENT_ADULT | LINKED_ADULT
  role         HouseholdRole         // MANAGER | MEMBER
  status       HouseholdMemberStatus // INVITED | ACTIVE | LEFT | REMOVED
  joinedAt     DateTime?
  leftAt       DateTime?
  version      Int      @default(1)
  @@unique([householdId, personId])
  @@index([personId, status])
}
model ProxyGrant {
  id                  String   @id @default(cuid())
  memberPersonId      String                 // whose data
  proxyPersonId       String                 // who acts
  householdId         String?
  basis               ProxyBasis             // GUARDIAN | RECORDED_CONSENT | MEMBER_CHOICE
  permissions         ProxyPermission[]      // VIEW | UPLOAD | BOOK | SHARE | INSURANCE | USE_AI
  categories          ShareCategory[]        // 4c's categories, for VIEW and USE_AI
  sensitiveCategories RagSensitiveCategory[] @default([])
  status              ProxyGrantStatus       // ACTIVE | REVOKED | LAPSED
  grantedByPersonId   String                 // the member, or the guardian for a minor
  evidence            Json     @default("{}") // RECORDED_CONSENT: who recorded it, document refs, date
  validUntil          DateTime?
  lapsedReason        String?                // CAME_OF_AGE | MEMBER_CLAIMED | MEMBER_CLOSED
  version             Int      @default(1)
  createdAt           DateTime @default(now())
  revokedAt           DateTime?
  @@index([memberPersonId, status])
  @@index([proxyPersonId, status])
}
```

**Changes to existing models:**
- `Person` gains `managedByHousehold Boolean` (true for a profile with no login of its own).
- `PersonAccount` is unchanged: a managed profile simply has none.

**Configuration:** `household.max_members` (default 8, organization-independent, platform-scoped).

## 4. Member types and their lifecycles

| Type | Login | Created by | Basis of proxies | The member can |
|---|---|---|---|---|
| SELF | Own | The manager themselves | — | Everything |
| MANAGED_MINOR | None (until 18 and claimed) | A manager who declares they are the parent or legal guardian | GUARDIAN | At 18: claim their account, then choose (§6) |
| DEPENDENT_ADULT | None, or their own | A manager, with the adult's consent recorded (who, when, how; a document where capacity is the reason) | RECORDED_CONSENT | Take control back at any time: claim with their own verified login, after which every grant becomes their choice |
| LINKED_ADULT | Own | Invited by a manager; joins by accepting | MEMBER_CHOICE | Choose what each proxy sees and does, change it, remove it |

**Adding a managed profile** creates a new `Person` (`managedByHousehold`) and its facility records only through the existing paths:
- self-registration at a facility on the member's behalf, recorded as by the proxy;
- linking an existing facility record by its code, sent to the contact on that record.

No fuzzy matching, as in Phase 0.

**Removing a member:**
- **Linked or dependent adult:** leaves the household, and their grants to the household's proxies are revoked unless they keep them individually.
- **Managed minor:** can be moved between households only by a manager holding GUARDIAN.

**A household with no manager left closes.** Its managed profiles stay intact, and a support process (recorded, audited) attaches them to a new guardian. Nothing is deleted.

## 5. Proxy permissions and categories

| Permission | Lets the proxy | Notes |
|---|---|---|
| VIEW | Read the member's record (facility records and person-level data) within `categories` and the sensitive opt-ins | The same category mapping as 4c, plus allergies |
| UPLOAD | Upload documents to the member's Person and review the extracted facts | Facts confirmed by a proxy are labelled "patient-provided (by proxy)" |
| BOOK | Book, reschedule and cancel the member's appointments | The booking engine records the proxy as the actor |
| SHARE | Issue the member's codes, approve their access requests, within the proxy's own categories | A proxy can never share more than they can see |
| INSURANCE | View and manage the member's insurance cards, pre-arrival check-in and payments (5c) | |
| USE_AI | Explain-my-report, health timeline and pre-visit questions over what VIEW allows | Patient-audience modes only, with the member's AI consent |

- **Every proxy action is logged** in the member's access log (`PersonAccessLogEntry`, `via: PROXY`, with the proxy's Person). The member (if an adult) sees it.
- **Sensitive categories** are hidden from every proxy by default. The member opts in per grant; for a managed minor, the guardian decides (§13, question 2).

## 6. Coming of age

A runner sweep (`household-coming-of-age`, daily) finds managed minors whose date of birth (precision DAY) passed 18. For each it does, in one transaction:

1. lapses every GUARDIAN grant (`LAPSED`, `CAME_OF_AGE`), with events;
2. lapses the guardian-given person consents (already built in 4b: `PersonConsent` → `LAPSED`);
3. marks the member as awaiting a claim.

**Before and after:**
- 30 days before the birthday, the managers are told, with a "hand over" flow that sends a claim invitation to the member's own verified contact.
- After the birthday, a manager sees only that the profile now belongs to its owner, unless the member, having claimed it, grants them access (`MEMBER_CHOICE`).
- Without a known date of birth (precision YEAR or unknown), the sweep uses 1 January of the following year. A profile with no date of birth at all can't be a managed minor.

**Claiming:** the member verifies a contact (an OTP to their own phone or email), which creates their login (`PersonAccount`). They then see every grant that existed and choose, grant by grant, to restore it or not.

## 7. Access through the resolver

- **`personAccess(actor, personId, purpose)`** gains `{ kind: "PROXY", userId }`. It returns `{ via: "PROXY", categories, sensitive, permissions }` from the ACTIVE `ProxyGrant` whose proxy is the actor's own Person, or null.
- **Every proxy read and write** goes through it: no route checks household membership directly. Membership alone gives nothing.
- **The `PROXY` document viewer** (Week 4c) becomes grant-aware. Under VIEW, a proxy sees the member's uploads and patient-provided entries, if UPLOADS is among the grant's categories, and only entries in the granted categories.
- **RAG** gains a `PROXY` path:
  - USE_AI only;
  - patient-audience modes;
  - scope from the grant (categories, sensitive opt-ins);
  - person and facility segments of the member;
  - the member's `AI_ASSISTANCE` consent (or the guardian's, for a minor) checked as today.
- **The profile switcher** changes the subject, never the actor. Every request names the member and is checked against the grant.

## 8. Existing family delegations

`PatientDelegation` stays: a facility-level, read-only delegation over one facility record's surfaces. Nothing is converted automatically.

- **No guessing:** a delegation's surfaces (APPOINTMENTS, RECORDS, …) aren't proxy permissions, and guessing a mapping would widen or narrow someone's choice.
- **Offer, don't convert:** the patient is offered "turn this into a household proxy". Choosing it creates a `ProxyGrant` with exactly the permissions they tick and revokes the delegation, each with its event.
- **Both can exist side by side.** The resolver unions nothing: each path is checked on its own terms.

## 9. Events

All are PERSON scope, SENSITIVE (except where noted), with ids and closed codes only, v1.

| Event | Payload |
|---|---|
| `HouseholdCreated` (INTERNAL) | `householdId, createdByPersonId` |
| `HouseholdMemberStatusChanged` | `householdId, memberPersonId, memberType, from, to` |
| `ProxyGrantChanged` | `grantId, memberPersonId, proxyPersonId, basis, from, to, permissions[], categories[], sensitiveCount, lapsedReason?` |
| `MemberCameOfAge` | `memberPersonId, householdId` |
| `MemberAccountClaimed` | `memberPersonId` |

**Consumers:**
- `rag-indexer`: none; grants are filters.
- `task-generator`: notifies the managers 30 days before a member comes of age, and the member when a grant about them changes.

## 10. Gates

| Gate | Proves |
|---|---|
| `verify-postgres-household-proxies` | Each permission admits exactly its actions (VIEW without BOOK can't book; SHARE never exceeds the proxy's categories). Membership without a grant gives nothing. Every proxy action lands in the member's access log. Events |
| `verify-postgres-coming-of-age` | With a clock at the 18th birthday, GUARDIAN grants and guardian consents lapse with events. The manager then sees nothing. Claiming restores only what the member chooses. YEAR-precision dates use the next 1 January |
| `verify-postgres-proxy-sensitive` | Sensitive canaries are absent for proxies without an opt-in, on every path (record view, documents, AI), and present with it |
| `verify-postgres-proxy-leaks` | A proxy of member A sees nothing of member B in the same household. A removed proxy sees nothing at once. The profile switcher can't be used to name a member without a grant (zero tolerance, with positive controls) |
| `verify-postgres-delegation-coexistence` | Existing delegations work unchanged. "Convert" creates exactly the ticked grant and revokes the delegation. Nothing is converted without the patient |
| Core journey (extended) | A parent adds a child → uploads a report for them → the child's record shows it as patient-provided (by proxy) → the parent books for the child → the child turns 18 → the parent's access lapses |

## 11. Order of wiring

1. Models, enums and the migration; tenancy; events; configuration.
2. `personAccess` PROXY way in, and the grant-aware `PROXY` viewer. Gate: proxy-leaks, with the existing delegate checks.
3. Households: create, invite, accept, managed profiles, the switcher (subject only).
4. Permissions one by one: VIEW, UPLOAD, BOOK, SHARE, INSURANCE, USE_AI (the RAG PROXY path). Gate: household-proxies.
5. Sensitive opt-ins per grant. Gate: proxy-sensitive.
6. Coming of age: the sweep, notices, claim. Gate: coming-of-age.
7. Delegation offer-to-convert. Gate: delegation-coexistence.
8. Screens and the core-journey extension.

## 12. Decisions taken for you

1. **Every member keeps their own Person;** households are a grouping plus grants, never a shared record.
2. **Membership confers nothing.** Only a `ProxyGrant` does, checked by `personAccess`.
3. **Sensitive categories are hidden from every proxy by default,** including guardians, until the member (or, for a minor, the guardian) opts in per grant.
4. **At 18 every guardian grant lapses,** and the member decides afresh after claiming. There is no "keep access unless the child objects".
5. **Existing family delegations are not converted automatically;** the patient is offered a conversion with explicit choices.
6. **A proxy can't share more than they can see,** and can't grant proxies themselves.
7. **Facts confirmed by a proxy are labelled "by proxy"** wherever patient-provided labels appear.
8. **A household without managers closes,** but managed profiles are never deleted; a recorded support process reattaches them.
9. **Profiles with no date of birth can't be managed minors;** a YEAR-precision date comes of age on the next 1 January.

## 13. Open questions

1. **Legal:**
   - What evidence suffices for a dependent adult's recorded consent, or for guardianship of an adult lacking capacity?
   - Who may record it: any manager, or only after a verification step?
2. **Clinical advisor and legal: adolescent confidentiality.** Should a guardian be able to opt in to a 16-year-old's sexual or reproductive health records, or should those stay hidden from guardians regardless?
3. **Member limit:** 8 by default. Is it per household or per manager? Can a person belong to two households (e.g. divorced parents)? The recommendation is yes: grants are per proxy, not per household.
4. **Claiming without a contact:** how does a member who has never had their own phone or email claim at 18? In person at a facility (the existing in-person verification)?
5. **Proxy-confirmed facts:** should a facility weigh them differently from member-confirmed ones in conflict detection?
6. **DPDP verifiable parental consent:** what verification of the guardian's identity is required at household creation for a child's profile?

## 14. As built (Week 5b, 2026-10-20)

Built on branch `foundation/w5b-households`. Where this section and §1–§13 differ, this section holds.

### 14.1 Answers given with the task

| Question | Answer, as built |
|---|---|
| A dependent adult's proxy (§13.1) | **One of three:** the adult's own code (sent to their own phone or email, never one that belongs to another profile, the manager's included); a **two-staff in-person check** (two different staff members of one facility, each recording it, the adult present; the family gives them the member reference shown on screen, and staff never see a list of who is waiting); or a **staff-reviewed legal document** (a power of attorney, a guardianship or other court order, uploaded to the adult's profile; the reviewer reads it through a 5-minute URL, audited). Until then the grant is `PENDING_CONFIRMATION` and gives nothing. |
| Adolescent confidentiality (§13.2) | **Guardians don't see a 12–17-year-old's sensitive categories.** For a child under 12 the guardian may opt in per grant; from 12 an opt-in is refused, and one stored earlier is ignored at read time (pending lawyer review). |
| Member limit (§13.3) | **8 members per household**, the manager's own profile included (invited and pending members count). |
| Claiming without a contact (§13.4) | **In person:** a facility staff member checks the member's ID (type and last 4 recorded, audited) and hands over a one-time code; the member claims with it at `/claim`. |
| Proxy-confirmed facts (§13.5) | **Labelled "confirmed by proxy"** wherever patient-provided entries appear: the entry (`PatientProvidedRecord.confirmedByProxy`), its description, the timeline, the AI index and the answer's labels. Conflict detection is unchanged. |
| Verifiable parental consent (§13.6) | **A code to the parent's own verified phone + a relationship declaration** (mother, father or legal guardian; the declaration's text is stored with the consent). Pending lawyer review. |

### 14.2 Code

- `src/lib/household/`: `vocab.ts`, `grants.ts` (grants, `proxyGrantFor`, the switcher, a member's own view and control of their proxies), `households.ts` (households, children, dependent adults, linked adults), `dependentConsent.ts`, `comingOfAge.ts` (the sweep, claims, restoring grants), `proxy.ts` (VIEW, UPLOAD, BOOK, SHARE, INSURANCE).
- `personAccess` gains the `PROXY` way in; every proxy route goes through it. Membership alone gives nothing.
- The 4a/4b refusals are replaced by permission checks: fact review takes a member with UPLOAD (`reviewedVia: PROXY`); the AI's patient modes take a `PROXY` path with USE_AI over the grant's categories and opt-ins; uploads and bookings act for a Person, with the proxy recorded as the actor.
- Migration `20261026100000_households` (additive), with CHECKs and one live grant per member and proxy.
- Events: `HouseholdCreated`, `HouseholdMemberStatusChanged`, `ProxyGrantChanged`, `DependentConsentChanged`, `MemberCameOfAge`, `MemberAccountClaimed`; `PersonCreated` v2 (source `HOUSEHOLD`) and `PersonNotificationQueued` v2 (`COMING_OF_AGE`, the 30-day notice).
- Screens: `/patient/household` (the household, adding a child, inviting, the profile switcher, acting for a member, who acts for you), `/claim`. Staff actions are APIs (`/api/hospital/household/…`).

### 14.3 Departures

1. **Existing facility delegations are left as they are** (§8): the offer to convert one into a proxy grant isn't built; delegations keep working unchanged and stay refused by the AI.
2. **The grant's basis can change:** when an adult member changes a grant, it becomes theirs (`MEMBER_CHOICE`).
3. **A managed profile has its creator's data classification** (a synthetic family stays synthetic). For real data, a guardian deciding the child's processing consents (`DOCUMENT_PROCESSING`, `AI_ASSISTANCE`) isn't wired: those decisions are still owner-only, so a real child's uploads aren't read until that is added (pre-launch item 22).
4. **No household support process** for a household left with no manager (§4): managed profiles are never deleted; reattachment is a support task (pre-launch item 22).
5. **A Person merge** re-points households and grants; a membership the surviving person already has is removed rather than duplicated, and a grant that would point at the same person is revoked.

### 14.4 Gates

| Gate | Checks |
|---|---|
| `verify-postgres-household-proxies` | 42: parental consent (code, declaration, date of birth), the GUARDIAN grant, membership gives nothing, each permission exactly, SHARE never more than VIEW, "confirmed by proxy", every proxy action logged, the three dependent-adult methods, a linked adult's own choice and removal, the 8-member limit |
| `verify-postgres-coming-of-age` | 19: the 30-day notice, the birthday (grants and consents lapse, the manager sees nothing), YEAR precision, claiming by own contact and in person, restoring by choice, a dependent adult taking control back |
| `verify-postgres-proxy-leaks` | 14: sensitive canaries absent without an opt-in on every path and present with it (under 12), refused and ignored from 12, member A's proxy sees nothing of member B, a removed proxy at once, USE_AI and staff modes |
| Core journey | A parent adds a child → uploads for them (confirmed by proxy) → books for them → the child turns 18 → the parent's access lapses |
| Browser smoke (`e2e/household.spec.ts`) | Start a household → add a child with the code → switch → upload → confirm (by proxy) |
