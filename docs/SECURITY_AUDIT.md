# Security Audit — Phase 0

Findings from a direct code audit (not a penetration test) of
authentication, authorization, tenant/facility/department scoping, and
object-level authorization across the repository. Verified against actual
route handlers, not against documentation claims. One finding (S-06) was
fixed during this audit — see the entry for what changed.

Severity: **CRITICAL** (exploitable now, real harm) · **HIGH** (exploitable
under plausible conditions, or systemic) · **MEDIUM** (real gap, limited
blast radius or requires an unusual precondition) · **LOW** (best-practice
gap, no realistic near-term exploit).

---

## CRITICAL

### S-01 — The original Patient/Doctor/Hospital/Admin systems have no server-side authorization at all

**Location**: `src/store/useAuthStore.ts`, every page under
`src/app/{dashboard,hospital,lab,onboarding,settings}/`,
`src/app/admin/(dashboard)/*`.

**Finding**: "Sign-in" for `patient`, `doctor`, `lab`, `hospital` roles
accepts any syntactically valid email + a ≥4-character password and
fabricates a full `AuthUser` object client-side — there is no server
round-trip whatsoever. "Sign-in" for `admin`/`staff` does call
`/api/admin-auth`, but the response is a bare `{ok: true}`; no session
token is issued, so **every subsequent request, including every admin
data operation, is authorized by nothing but a client-side
`useAuthStore.user` check that a page's `useEffect` performs after
render**. Opening browser devtools and writing
`localStorage.setItem('aarogya-auth', ...)` with a hand-crafted admin
user object grants full admin UI access with zero server verification.

**Why CRITICAL and not lower**: this is the entire authorization model for
four of the app's user-facing surfaces. There is no partial mitigation —
it is not "weak," it is **absent**. It was, however, the original,
disclosed design of a client-only prototype (`README.md`'s own "Notes"
section historically said as much) — this finding is about the *current*
production risk if this surface is ever exposed to real users/data as-is,
not a claim that it was secretly broken relative to its stated design.

**Fix status**: NOT fixed this phase — fixing it means giving this system
the same real backend Scholar/Hospital OS have, which is exactly the
Phase 1 "Unified Foundation" work this audit is scoping, not a
Phase-0-safe patch. Flagging here is what unblocks that phase.

### S-02 — No rate limiting anywhere in the codebase

**Location**: `/api/scholar-auth/login`, `/api/admin-auth`, every mutating
route.

**Finding**: `grep -r "rate.?limit"` across `src/` returns nothing. Login
endpoints (`/api/scholar-auth/login`, used by Scholar *and* Hospital OS)
accept unlimited password attempts with no lockout, backoff, or CAPTCHA.
Combined with scrypt (not the fastest hash, but far from bcrypt/argon2id's
tuned cost either — see S-03), this is a real, unbounded credential-
stuffing / brute-force surface for every account in the system, including
`HOSPITAL_ADMIN` and `AAROGYA_ADMIN`.

**Fix status**: NOT fixed — needs a real decision (in-memory for single
instance vs. a shared store for multi-instance deployment) that belongs in
Phase 1, not a Phase-0 patch. Documented as a hard prerequisite before any
non-local deployment.

---

## HIGH

### S-03 — Session has no revocation mechanism

**Location**: `src/lib/auth/session.ts`.

**Finding**: Sessions are a signed, stateless cookie with no server-side
session table. There is no "log out this device," no admin "revoke this
user's sessions," and no way to invalidate a single compromised session
without rotating `AUTH_SECRET` for *every* session platform-wide. This was
a documented, deliberate v1 tradeoff when Scholar was built
(`docs/STUDENT_PLATFORM_ARCHITECTURE.md` §2.2) — restated here as a
security finding because Hospital OS now depends on the same primitive
for `HOSPITAL_ADMIN`/`DOCTOR`/`NURSE` accounts, raising the stakes.

### S-04 — Verification-document upload has no size or MIME-type validation

**Location**: `src/app/api/student/register/route.ts` (`file.size > 0`
is the *entire* check), `src/lib/verification/provider.ts`.

**Finding**: any file type, of any size, can be uploaded as a "student ID
card" or "enrollment document." No allowlist, no cap. Stored to
`.data/verification-uploads/` (correctly outside `public/`, never served —
see `docs/CLINICAL_EDUCATION_PRIVACY.md` §4), so this is not a direct RCE
vector today (nothing executes or renders the file), but it is an
unbounded disk-fill / storage-cost vector and a real gap before this
accepts uploads from the public internet.

### S-05 — Cross-facility tenant isolation is architecturally sound but not tested against a second tenant

**Location**: `src/lib/auth/hospitalRbac.ts` (`requireFacilityStaff`),
every `src/app/api/hospital/*` route.

**Finding**: every route correctly derives `facilityId` from the caller's
`HospitalStaffProfile` (never from client input, except the
`AAROGYA_ADMIN`-only cross-facility path which requires an explicit param
that ordinary roles cannot supply). The pattern is right. But only one
facility ("Aarogya Medical Centre") is seeded — there is no automated test
or manual verification that a doctor at Facility A actually receives a
404 on Facility B's patient/encounter/bed IDs, because Facility B doesn't
exist in the running system yet. This is a "reviewed, not proven" finding.

**Recommended before any second facility goes live**: seed a second
facility and add an integration test (or a manual pass) asserting 404 on
every `[id]` route for a cross-facility ID.

### S-06 — [FIXED THIS AUDIT] `getCaseFull()` did not filter unpublished cases

**Location**: `src/lib/clinical/providers/syntheticCaseProvider.ts`.

**Finding**: `listCases()` (used by the Clinical Feed) correctly filters
`isPublished: true`. `getCaseFull()` (used by
`/api/student/cases/[id]`, the action route, and the submit route) did
**not** — a caller who obtained an unpublished/draft `ClinicalCase.id`
(e.g. an educator's in-progress draft, `isPublished: false` by default —
see `src/app/api/educator/cases/route.ts`) could open and even attempt it
via the case-workspace API, despite it never appearing in any feed.

**Practical risk**: low (Prisma `cuid()` ids have ~128 bits of entropy,
not practically enumerable) but real — the gap existed between documented
intent ("students only see published cases") and actual code.

**Fix applied**: `getCaseFull()` now filters `isPublished: true` in the
same `findUnique` call, matching `listCases()`. Verified live: creating an
unpublished draft case and calling `getCaseFull(draftId)` now returns
`null`. No functionality depended on the old behavior (no route currently
needs an educator to preview their own unpublished draft through this
method), so this is a pure tightening with zero regression risk —
confirmed via `npx vitest run` (69/69 still passing) and a clean
`npm run build`.

---

## MEDIUM

### S-07 — `AAROGYA_ADMIN`'s cross-facility path trusts a client-supplied `facilityId` with no further check

**Location**: `src/lib/auth/hospitalRbac.ts`.

**Finding**: for `AAROGYA_ADMIN`, `requireFacilityStaff()` uses whatever
`facilityId` the caller passes (typically a query param) with no
verification that facility even exists. Every route then queries Prisma
with that `facilityId`, which will simply return empty results for a
bogus id — not a data leak, but an unvalidated-input smell worth a
`prisma.facility.findUniqueOrThrow` guard for a clearer error.

### S-08 — Discharge/order/billing "who did this" audit fields are unconstrained strings, not foreign keys

**Location**: see `docs/DATA_MODEL_AUDIT.md` §9.1 for the full list
(`BedStateEvent.byUserId`, `Transfer.byUserId`, `Discharge.signedByStaffId`,
`Vital.recordedByStaffId`).

**Finding**: these fields are populated correctly by every route today
(always from `session.userId` or `staff.id`, never client input), so this
is not currently exploitable — but because the schema doesn't constrain
them, nothing stops a future bug from writing an arbitrary string here,
and audit queries joining through these fields will silently return
nothing for a mismatched id rather than failing loudly.

### S-09 — No CSRF token; relies entirely on `sameSite: lax`

**Location**: `src/lib/auth/session.ts`.

**Finding**: the session cookie is `sameSite: "lax"`, which does block the
cookie from being sent on cross-site POST requests (the main CSRF vector
for state-changing actions) in all current major browsers — a real,
adequate mitigation for the common case. It is not a defense-in-depth
token-based CSRF protection, and `lax` cookie behavior has had browser
inconsistencies historically. Acceptable for Phase 1; a double-submit CSRF
token would be the belt-and-suspenders addition before handling real
patient data at scale.

---

## LOW

### S-10 — No Content-Security-Policy / security headers configured

**Location**: `next.config.ts` (empty — no `headers()` function).

**Finding**: no CSP, `X-Frame-Options`, `X-Content-Type-Options`, or
`Referrer-Policy` are set. Standard hardening step, not urgent at current
stage (no user-generated HTML rendering surface that would make XSS
trivially exploitable was found), but cheap to add.

### S-11 — `ADMIN_EMAIL`/`ADMIN_PASSWORD` compared as plaintext env vars

**Location**: `src/app/api/admin-auth/route.ts`.

**Finding**: `password !== adminPassword` — a plaintext string comparison
(not even `timingSafeEqual`, unlike Scholar's session signature check).
Given S-01 (this whole surface has no session anyway), fixing the
comparison alone wouldn't meaningfully improve security — noted for
completeness, real fix is retiring this route as part of unifying auth
(Phase 1).

---

## What was verified clean

- Every `src/app/api/{student,educator,admin,hospital}/*` route (the
  systems built with real backends) calls a `require*` auth function
  before touching the database — confirmed by grepping all 40+ route
  files (only `/api/student/register`, the sign-up endpoint, correctly
  has none).
- Role is re-derived from the database on every request
  (`requireSession()` in `src/lib/auth/rbac.ts`), never trusted from the
  session cookie's embedded value alone.
- `[id]` routes across Scholar and Hospital OS consistently load the row
  first and check tenant/ownership before returning data, using
  `NotFoundError` (404) rather than `ForbiddenError` (403) on mismatch so
  a caller can't distinguish "doesn't exist" from "exists but isn't
  yours" — correct IDOR-resistant pattern, applied consistently.
- Password hashing uses Node's built-in `scrypt` with a random salt per
  password and `timingSafeEqual` for comparison — not a home-grown cipher,
  reasonable for this stage (see S-03 for what's still missing:
  revocation, not the hash itself).
- No secrets are committed to the repository — `.env`/`.env.local` are
  gitignored, `.env.example` contains only placeholder/documentation
  values, verified via `git status`/`git diff` across every commit this
  session.
