# Aarogya Scholar — Threat Model

Scope: the student/educator/admin surfaces added in this change
(`/student`, `/educator`, `/admin/student-verifications`, `/api/student/*`,
`/api/educator/*`, `/api/admin/verifications/students`). Out of scope: the
pre-existing Patient/Doctor prototype, which has no server-side security
model to begin with (see architecture doc §1) and is unchanged here.

For each threat: the concern, what stops it today, and residual risk.

## T-01 — Student reads the answer key before submitting

**Concern**: a student inspects network responses to find the reference
diagnosis, rubric, or critical/unsafe action lists before completing a case.

**Mitigation**: `ClinicalCaseFull` (which includes `referenceDx`, `rubric`,
`content.managementPathway[].isCritical/isUnsafeIfChosen`,
`content.investigations[].isDiagnostic`, `viva[].idealAnswerPoints`) is never
serialized into a response for an in-progress attempt.
`GET /api/student/cases/[id]` and `POST .../action` both build their
response through `toPublicView()` (`src/lib/caseEngine/publicView.ts`),
which only reads the *fields it explicitly lists* off the full case — it
cannot accidentally forward the whole object because it constructs a new
object field by field. `toDebriefView()` (which does expose the answer key)
is only ever called from `POST .../submit`, after `attempt.submittedAt` is
set server-side.

**Residual risk**: a student can call `/action` speculatively with guessed
IDs (e.g. iterate `h-1`..`h-20`) to enumerate `availableHistoryQuestions` —
but that endpoint already returns the full *question list* by design (ids +
prompts, never answers), so this reveals nothing beyond what's already
shown. Investigation results and exam findings are only revealed once
actually ordered/selected, at which point revealing them is correct
(the student paid the "cost" of ordering).

## T-02 — Client-side role/status spoofing

**Concern**: a student edits Zustand state, cookies, or request bodies to
claim `role: STUDENT` -> `EDUCATOR`/`AAROGYA_ADMIN`, or claims
`verificationStatus: VERIFIED` without being verified.

**Mitigation**: role and verification status are never read from anything
the client sends. `requireSession()` (`src/lib/auth/rbac.ts`) reads the
HMAC-signed session cookie, then **re-derives the role from the database**
on every request (`prisma.user.findUnique`) rather than trusting the value
embedded in the cookie payload — a defense-in-depth measure in case a future
change makes the cookie payload's role stale relative to a DB update (e.g.
an admin demotes a compromised account). `requireVerifiedStudent()`
(`src/lib/auth/currentStudent.ts`) separately loads `StudentProfile` from
the DB and checks `verificationStatus === VERIFIED` — Zustand never enters
this path at all.

**Residual risk**: none identified for this flow specifically. General
session risk is covered in T-05.

## T-03 — Case ID enumeration

**Concern**: a student iterates sequential case IDs to find unpublished or
educator-draft cases.

**Mitigation**: `ClinicalCase.id` is a Prisma `cuid()` — not sequential or
guessable. `SyntheticCaseProvider.listCases()` filters `isPublished: true`,
so unpublished educator drafts never appear in the feed. `getCaseFull()`
does *not* filter on `isPublished` (an educator previewing their own draft
needs to fetch it) — this means a student who somehow obtains a draft's
`cuid` could open it. Given `cuid()`'s ~128 bits of entropy this is not
practically enumerable, but it is a gap worth closing before any real
educator-authored content goes live: **recommended follow-up** — filter
`getCaseFull()` by `isPublished` for STUDENT-role callers specifically.

## T-04 — Verification document access

**Concern**: a student or another party accesses another student's ID card
/ enrollment document.

**Mitigation**: `MockVerificationProvider` (`src/lib/verification/provider.ts`)
writes to `.data/verification-uploads/`, a directory outside `public/` that
Next.js never serves as a static route, and outside `src/`, so no page or
API route path maps to it. The only code that reads from that directory is
`VerificationProvider.read()`, guarded by a path-prefix check — and no
route currently calls it (a real admin review UI would need to add a
narrowly-scoped, admin-only download route that calls it explicitly).
`VerificationDocument` rows store only `storageRef` + `sha256`, never bytes,
and are never joined into any student-facing or public API response.

**Residual risk**: `.data/` is a local filesystem directory — fine for this
prototype's local dev/demo posture, not acceptable for production, where it
must be replaced with a real access-logged private object store (see
docs/REAL_CLINICAL_DATA_INTEGRATION.md and
docs/CLINICAL_EDUCATION_PRIVACY.md §4).

## T-05 — Session forgery / hijacking

**Concern**: forging a session cookie, or reusing a leaked one.

**Mitigation**: cookie is `httpOnly` (unreadable by page JS, mitigating XSS
exfiltration), `sameSite: lax` (mitigates CSRF for state-changing requests
originating from third-party sites), and HMAC-signed with `AUTH_SECRET`
(`src/lib/auth/session.ts`) — a forged cookie without the correct signature
is rejected by `timingSafeEqual` comparison (not vulnerable to timing
attacks). `secure` is set in production. Session TTL is 14 days; there is no
revocation list, so a leaked valid cookie remains valid until expiry or
`AUTH_SECRET` rotation (which invalidates *all* sessions at once).

**Residual risk**: no per-session revocation (e.g. "log out this device").
Acceptable for a v1 education platform; not acceptable for real clinical
system auth (see architecture doc §2.2 for the recommended production path
— Auth.js/Clerk/WorkOS with real session revocation).

## T-06 — IDOR on case attempts

**Concern**: a student passes another student's `attemptId` to `/action` or
`/submit` to view or tamper with someone else's in-progress case.

**Mitigation**: every attempt-scoped route
(`.../action`, `.../submit`) loads the attempt by ID and then checks
`attempt.studentId !== session.userId` (and `attempt.caseId !== id`),
throwing `NotFoundError` (not `ForbiddenError`, to avoid confirming the
attempt ID's existence to a caller who doesn't own it) if either mismatches.

## T-07 — Prompt injection via the simulated patient

**Concern**: a student crafts a question designed to make the AI-portrayed
patient reveal the diagnosis, invent a lab value, or break character to
"teach" (bypassing the point of the exercise), or reveal system-prompt
internals.

**Mitigation**: `buildPatientDialoguePrompt()` (`src/lib/ai/prompts.ts`)
constrains the model to a `CASE_FACTS` block built entirely from data
already revealed to *this* attempt (`knownHistory`, `knownExamFindings`,
`knownInvestigationResults`) — never the full case, never the answer key.
The model is explicitly instructed not to invent facts, not to teach, and
to say "I don't know" for anything outside `CASE_FACTS`. Because the
diagnosis/rubric/critical-actions are never in the prompt in the first
place, no prompt-injection payload can extract them from this call — there
is nothing to extract. `MockAIProvider` (used whenever no API key is
configured) is fully deterministic and cannot be prompt-injected at all.

**Residual risk**: an LLM can still be steered into confidently *guessing* a
plausible-sounding but wrong fact despite instructions not to. This is a
generic LLM reliability property, not fully eliminable by prompting alone;
mitigated by the model never holding ground-truth clinical facts it could
leak, and by scoring being fully deterministic and independent of anything
the simulated patient says (T-08's concern is the mirror case).

## T-08 — AI-influenced scoring manipulation

**Concern**: a student manipulates the AI tutor/examiner into giving
unwarranted positive feedback, or that feedback somehow inflates the score.

**Mitigation**: `CaseScoringEngine.scoreCaseAttempt()`
(`src/lib/scoring/engine.ts`) is a pure, deterministic function over
structured attempt data (revealed facts, submitted differential/diagnosis/
management/prescription, hints used) and the case's server-only rubric.
The AI provider is never called during scoring and has no code path that
can write to `CaseAttempt.score`. `tutorFeedback()` in `DEBRIEF` mode is
called *after* scoring completes and only produces narrative text appended
to the response — it cannot alter `breakdown.total`.

## T-09 — Malicious verification-document upload

**Concern**: a student uploads a file designed to exploit a document
viewer, or an oversized file for storage exhaustion.

**Mitigation (partial)**: files are stored, never executed or rendered
inline by the current code (no viewer exists yet). `MockVerificationProvider`
sanitizes the extension used in the stored filename. **Gap**: there is no
file-size limit or MIME-type allowlist enforced in this pass — a production
deployment must add both (recommended: cap at a few MB, allowlist
`image/*` and `application/pdf`, and scan uploads) before accepting real
student documents at scale.

## T-10 — Cross-institution data leakage

**Concern**: an educator or institution admin at Institution A sees
students/cohorts belonging to Institution B.

**Status**: `Institution`/`Cohort`/`CohortMembership` models exist in the
schema, but the educator case-review/cohort-management UI that would need
this boundary is not built in this pass (see architecture doc §4,
"deferred"). `admin:verification:manage` (used by
`/api/admin/verifications/students`) is currently platform-wide
(`AAROGYA_ADMIN`), matching the brief's "AAROGYA_ADMIN reviews all"
model — there is no `INSTITUTION_ADMIN`-scoped review endpoint yet.
**This must be built before any multi-institution educator rollout.**

## T-11 — Educator authoring privacy escape hatch

**Concern**: an educator pastes real patient identifiers into the case
authoring form.

**Mitigation**: `POST /api/educator/cases` runs the authored case content
through `assertSyntheticCaseIsClean()` before insert, which throws if any
field name on the *prohibited-identifier list* (`src/lib/privacy/privacyPolicy.ts`)
is present — a structural (field-name) check, not a content scanner. In
addition, the free-text fields (`title`, `chiefComplaint`, `presentation`)
are passed through `redactFreeText()` (the same pattern-based PHI scrubber
the Clinical Learning Data Gateway uses) before storage, catching
phone/email/Aadhaar/ABHA/MRN-shaped strings.

**Residual risk**: pattern-based redaction cannot catch a real *name* typed
into free text (names don't have a detectable pattern) or novel identifier
formats. A production deployment should additionally require an explicit
educator attestation ("this case contains no real patient information")
before publish, and ideally route first-time educator submissions through a
lightweight human review step.
