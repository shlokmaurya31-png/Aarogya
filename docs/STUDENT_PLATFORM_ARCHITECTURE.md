# Aarogya Scholar — Student Platform Architecture

This document describes the architecture of **Aarogya Scholar**, the medical-education
ecosystem added to the Aarogya AI repository. It covers what existed before this work,
what was added, and why.

## 1. Existing architecture (before this change)

Aarogya AI was a **prototype with no backend**:

- Next.js 16 App Router, React 19, TypeScript, Tailwind 4.
- All application state lived in Zustand stores (`src/store/*`), persisted to
  `localStorage` via `zustand/middleware persist`. There was no database.
- "Authentication" was a client-side illusion: `useAuthStore.signInPatient/Doctor/...`
  accepted almost any email/password and fabricated a `user` object. The one exception
  was `/api/admin-auth`, a route handler that checked `ADMIN_EMAIL`/`ADMIN_PASSWORD`
  env vars — still no session, no hashing, no cookie.
- A verification pattern already existed for **doctor / lab / hospital** signup:
  `VerificationApplication` objects pushed into `useAuthStore`, reviewed by an admin
  in `/admin/(dashboard)/verifications` (approve/reject, CSV export, activity log).
  This was the closest thing to a governance workflow in the codebase, and is the
  pattern Aarogya Scholar's verification system extends rather than replaces.
- AI: a single `/api/chat` route wraps `@anthropic-ai/sdk`, builds a system prompt by
  serializing mock patient data into text, and returns a completion. No streaming, no
  tool use, no separation between "prompt building" and "API call" beyond one file.
- i18n: `src/lib/i18n.ts` + `useLanguageStore` + `useTranslation()` hook, dictionary
  keyed by string paths (`t("admin.queue.title")`), 11 languages.
- Visual language: light theme by default with a dark variant via `data-theme`,
  CSS custom properties in `globals.css` mapped into Tailwind via `@theme inline`
  (`--color-ink`, `--color-cyan`, `--color-emerald`, etc.), glassy cards
  (`src/components/ui/Card.tsx`, `StatusPill.tsx`), Framer Motion for
  micro-interactions, Recharts for vitals.

This is a reasonable foundation for a marketing-grade prototype, but it cannot support
the Scholar requirement that **the server, not the browser, owns case answer keys,
scores, and verification status**. That required introducing real persistence and real
authentication for the first time in this repository.

## 2. New architecture (this change)

### 2.1 Persistence

Added **Prisma** with a **SQLite** file datasource (`prisma/dev.db`) for zero-setup
local development — no Docker, no Postgres server required. The schema
(`prisma/schema.prisma`) is written to be **Postgres-portable**: no SQLite-only types,
`String` ids via `cuid()`, ISO datetimes, JSON columns only where Postgres also
supports JSON. Moving to Postgres in production is a one-line datasource change
(`provider = "postgresql"`, add pgvector/full-text later if needed) — see
`docs/CLINICAL_EDUCATION_PRIVACY.md` §7 and `docs/REAL_CLINICAL_DATA_INTEGRATION.md`.

The existing Patient/Doctor client-state prototype (`useAuthStore`, `usePatientStore`,
etc.) is **untouched**. Aarogya Scholar is additive: new Prisma models, new API routes,
new `/student`, `/educator`, `/admin` (extended) routes. Nothing under the existing
dashboard was migrated to the database — that migration is out of scope here and is
called out as a follow-up in §12.

### 2.2 Authentication & sessions

No third-party auth library was added (`next-auth`/Auth.js v5 for the App Router was
evaluated but its credentials-provider + Prisma adapter wiring is itself a large surface
for a first pass). Instead:

- Passwords are hashed with Node's built-in `crypto.scrypt` (a standard, audited KDF —
  not a home-grown cipher), see `src/lib/auth/password.ts`.
- Sessions are an **httpOnly, signed cookie** containing `{ userId, role, exp }`,
  HMAC-signed with `AUTH_SECRET` via `crypto.createHmac`, see `src/lib/auth/session.ts`.
  The cookie is opaque to and unreadable by client JS. No session table is required for
  v1 (stateless, revocation is coarse — rotating `AUTH_SECRET` invalidates all sessions).
- Every `/api/student/*`, `/api/educator/*`, `/api/admin/*` route calls
  `requireSession()` / `requirePermission()` from `src/lib/auth/rbac.ts` **before**
  touching the database. The client never sends a role — the server reads it from the
  verified cookie every time. Zustand is UI cache only, never the authorization source
  of truth (see `docs/STUDENT_PLATFORM_THREAT_MODEL.md` T-02).

This is documented as v1 scope: a production deployment handling real institutional
data should move to a reviewed auth provider (Auth.js, Clerk, WorkOS) — see §12.

### 2.3 Roles & permissions

`src/lib/auth/permissions.ts` defines the role set (`PATIENT, DOCTOR, STUDENT,
EDUCATOR, INSTITUTION_ADMIN, AAROGYA_ADMIN`) and a permission table
(`student:case:view`, `student:rx:simulate`, `educator:case:create`,
`admin:verification:manage`, …). Route handlers declare the permission they require;
`requirePermission(session, "student:case:attempt")` throws a typed `ForbiddenError`
that maps to HTTP 403. No route infers authorization from a hidden navigation link.

### 2.4 Verification

`StudentVerification` extends the existing `VerificationApplication` shape
(role/name/facility/registrationId/proofFileName/status) with student-specific fields
(institution, course, academic year, verification method). It is reviewed from the
**same admin verifications queue** (`/admin/(dashboard)/verifications`), now filtered
by role including `student`, so admins get one inbox instead of a second app to check.

Verification documents are stored via a `VerificationProvider` interface
(`src/lib/verification/provider.ts`) with a `MockVerificationProvider` implementation
that writes to a restricted local directory (`.data/verification-uploads`, gitignored,
never served by a public route) and records only a reference + hash in the database —
never raw file bytes in a table a general query could return. See
`docs/CLINICAL_EDUCATION_PRIVACY.md` §4.

### 2.5 Clinical Learning Data Gateway (privacy architecture)

```
Clinical System (future)
   |
   v
Consent / authorization / governance layer   (future — not implemented)
   |
   v
Clinical Learning Data Gateway                 src/lib/clinical/gateway.ts
   |
   v
De-identification + minimization               src/lib/privacy/*
   |
   v
Educational Case Snapshot (ClinicalCase)        prisma model + src/types/clinicalCase.ts
   |
   v
Student Case Engine                             src/lib/caseEngine/*
```

`ClinicalCaseProvider` (`src/lib/clinical/provider.ts`) is the interface the case engine
depends on. Only `SyntheticCaseProvider` is wired up and active
(`CLINICAL_DATA_MODE=synthetic` is the only mode implemented; any other value throws at
boot — see `src/lib/clinical/config.ts`). `DeidentifiedClinicalFeedProvider`,
`HistoricalTeachingCaseProvider`, and `InstitutionCaseProvider` are documented as typed
stubs that throw `NotImplementedError` — they exist so the interface shape is real and
reviewable, not so they can be silently switched on. There is no code path from an
environment variable to a real clinical feed; enabling one requires implementing a new
class and passing institutional/legal review (§ `REAL_CLINICAL_DATA_INTEGRATION.md`).

De-identification helpers (`src/lib/privacy/`) are exercised by the seed script even
though seed data is synthetic from the start, so the pipeline has real test coverage
before it is ever pointed at anything sensitive:

- `deidentify.ts` — strips/generalizes direct & quasi-identifiers from a raw record.
- `educationalIdentity.ts` — generates a case-local synthetic name/identity, independent
  of and non-reversible to any source identity.
- `dateShift.ts` — per-case consistent date shifting (preserves intervals, hides real
  admission timestamps).
- `redaction.ts` — free-text PHI pattern scrubbing (phone/email/ABHA/Aadhaar/MRN shapes).
- `caseSanitizer.ts` — orchestrates the above into one `sanitizeToEducationalCase()` call
  the gateway invokes; this is the single choke point future real-data adapters must
  pass through.

### 2.6 Case engine

The case is a **server-authoritative state machine**, not a static document.
`ClinicalCase` (Prisma model + `src/types/clinicalCase.ts`) stores the full case
including `referenceDiagnosis`, `rubric`, `criticalActions`, `unsafeActions` — fields
that are **never serialized into a GET response**. `CaseAttempt` tracks a student's
progress through stages (`TRIAGE → HISTORY → PHYSICAL → DIFFERENTIAL →
INVESTIGATIONS → DIAGNOSIS → MANAGEMENT → PRESCRIPTION → DOCUMENTATION → VIVA →
DEBRIEF`), and `CaseAction` records every reveal/order/decision as an event, both for
the replay/debrief UI and as an audit trail. `src/lib/caseEngine/engine.ts` is the pure
function layer: given `(case, attempt, action)` it returns the next `attempt` state and
whatever *newly unlocked* fact the action reveals — the API route is a thin wrapper that
loads from Prisma, calls the engine, and persists the result. The client only ever
receives what the engine decides to reveal.

Scoring is deterministic (`src/lib/scoring/engine.ts`, `CaseScoringEngine`): a weighted
rubric (History/Exam/Differential/Investigations/Diagnosis/Management/Prescription/
Safety/Documentation) computed from the `CaseAction` log against the case's rubric
definition. The Anthropic-backed AI layer only ever adds *qualitative* narrative
feedback on top of a score that already exists — it cannot move the number.

### 2.7 AI architecture

`src/lib/ai/provider.ts` defines `AIProvider` with three server-side services used by
Scholar: `patientDialogue()`, `vivaExaminer()`, `tutorFeedback()`. `AnthropicAIProvider`
wraps `@anthropic-ai/sdk` (reusing the same SDK the existing `/api/chat` route uses, now
factored out of the route body). `MockAIProvider` provides deterministic, scripted
responses for every one of those three functions so **no page depends on
`ANTHROPIC_API_KEY` being present** — `getAIProvider()` picks the mock automatically when
the key is absent, and every AI-backed UI shows an "AI Tutor unavailable — structured
case mode remains available" banner rather than failing. React components never import
`@anthropic-ai/sdk` directly; they call `/api/student/...` routes which call the
provider server-side. See `docs/STUDENT_PLATFORM_THREAT_MODEL.md` T-07/T-08 for the
prompt-injection and fact-leakage boundary.

### 2.8 Routes

```
/student                      landing / sign-in entry (role selection)
/student/verify                verification wizard (multi-step)
/student/dashboard             Student Command Center
/student/cases                 Clinical Feed (filterable case list)
/student/cases/[caseId]        Case workspace (history/exam/dx/ix/mgmt/rx/notes)
/student/rxlab                 standalone prescription simulator
/student/viva                  AI viva
/student/progress              competency analytics
/student/passport              Clinical Passport (achievements/competencies)

/educator                      educator home
/educator/cases                case list (their institution's authored cases)
/educator/cases/create          schema-driven case author wizard

/admin/(dashboard)/verifications   extended to include role=student

/api/student/profile
/api/student/verification
/api/student/dashboard
/api/student/cases
/api/student/cases/[id]
/api/student/cases/[id]/action
/api/student/cases/[id]/submit
/api/student/progress
/api/student/viva
/api/student/rxlab/validate
/api/educator/cases
/api/admin/verifications
```

Additional routes from the original 100-section brief (`/student/emergency`,
`/student/diagnostics`, `/student/rounds`, `/student/skills`, `/student/notebook`,
`/student/knowledge`, `/student/challenges`, `/student/settings`,
`/student/onboarding`) are **not all built out as separate deep modules in this pass** —
see §12 "Deferred" for the explicit list and why. The navigation is built so adding them
is additive (new leaf route + nav entry), not a restructure.

### 2.9 Database entities (see `prisma/schema.prisma` for the authoritative source)

`User, StudentProfile, StudentVerification, Institution, ClinicalCase, CaseAttempt,
CaseAction, StudentCompetency, Achievement, StudentAchievement, NotebookEntry,
AuditEvent, VerificationDocument`.
`Cohort`/`CohortMembership`/`Assignment`/`AssignmentSubmission`/`LearningRecommendation`
are modeled in the Prisma schema (so the educator/cohort story type-checks end-to-end)
but do not yet have full UI — see §12.

### 2.10 Migration strategy

1. **This change**: additive. No existing table/store touched or removed.
2. **Next**: move the existing Patient/Doctor prototype's `PatientProfile`,
   `Prescription`, etc. onto the same Prisma database, replacing `localStorage`
   persistence with real API routes, reusing the same `session.ts`/`rbac.ts` primitives
   built here for Scholar. Until then, Patient/Doctor and Scholar are two different
   persistence models living side by side — documented, not hidden.
3. **Later**: swap SQLite → Postgres by changing the Prisma datasource + running
   `prisma migrate deploy` against a managed Postgres instance; the schema was written
   to make this a non-event.

## 3. Implementation phases actually executed in this pass

1. Prisma schema + migrations + seed (25 synthetic cases, demo users).
2. Auth (password hashing, session cookie, RBAC).
3. Privacy/de-identification library + Clinical Learning Data Gateway.
4. Case engine (state machine, scoring) + case types.
5. API routes for verification, dashboard, cases, actions, submit, progress.
6. Student UI: landing → verify → dashboard → clinical feed → case workspace →
   RxLab → Viva → progress → passport.
7. Admin verifications extended for students. Educator case list + minimal authoring.
8. AI provider abstraction with mock fallback; wired into patient dialogue, viva, tutor
   feedback, debrief narrative.
9. Landing page Scholar section.
10. Docs: this file, threat model, privacy, future real-data integration.
11. Vitest tests for RBAC, de-identification, case stage progression, scoring, Rx rules.
12. Lint, build, local runtime verification.

## 4. Explicitly deferred (see final report for the full list)

Grand Rounds authoring depth, cohort analytics dashboards, Emergency Arena's
countdown/deterioration simulator, Diagnostic Lab standalone drills, Knowledge Hub
content, Student Notebook, full command palette search, and push-notification providers
are scaffolded in the type system and/or given a minimal functional page, but are not
built to the same depth as the case engine / verification / RxLab / scoring core. This
mirrors the priority order given in the brief itself (items 1–11 before 12–15).
