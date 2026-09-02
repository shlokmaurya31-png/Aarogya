# API Audit — Phase 0

Inventory of all 42 route handlers under `src/app/api/`. Grouped by
system since each system has its own consistent internal pattern; the
inconsistencies that matter are almost entirely *between* systems, not
within one. Full per-route detail in the table; pattern analysis follows.

## 1. Common infrastructure

Two shared wrapper functions carry most of the "auth, validation, error
handling, response structure" weight:

- `withApiErrors(fn)` (`src/lib/auth/rbac.ts`): wraps a route body,
  catches `UnauthorizedError`/`ForbiddenError`/`NotFoundError`/
  `BadRequestError` and maps to 401/403/404/400 with `{error: message}`;
  anything else logs and returns a generic 500 `{error: "Internal error."}`
  (never leaks a stack trace or raw exception message to the client).
- `requireSession()` / `requirePermission()` / `requireFacilityStaff()` /
  `requireVerifiedStudent()` (layered — each calls the one before it):
  the actual auth/authz checks, always run first inside the wrapped
  function.

Every Scholar and Hospital OS route uses this pattern. The original
`/api/chat` and `/api/admin-auth` routes predate it and use ad hoc
`NextResponse.json(..., {status})` calls with no shared error wrapper —
this is the main cross-system inconsistency (see §4).

## 2. Route table

| Route | Method(s) | Auth | Tenant scope | Validation | Transaction | Audit event | Response shape |
|---|---|---|---|---|---|---|---|
| `/api/chat` | POST | none | n/a | manual (`message` string check) | n/a | none | `{text}` or `{error}` |
| `/api/admin-auth` | POST | none (checks env vars) | n/a | manual | n/a | none | `{ok:true}` or `{error}` |
| `/api/scholar-auth/login` | POST | none (creates session) | n/a | manual | n/a | none | `{id,role,displayName,email}` |
| `/api/scholar-auth/logout` | POST | requires existing session to matter | n/a | n/a | n/a | none | `{ok:true}` |
| `/api/scholar-auth/me` | GET | session (soft — returns `{user:null}` not 401) | n/a | n/a | n/a | none | `{user}` |
| `/api/student/register` | POST | none (sign-up) | n/a | Zod (`RegisterSchema`) | n/a | `student.verification.submitted` | `{ok,verificationStatus}` |
| `/api/student/verification/dev` | POST | session, dev-flag gated | own profile only | manual | n/a | `student.verification.approved/rejected` | `{verificationStatus}` |
| `/api/student/cases` | GET | `student:case:view` + verified | n/a (global catalog) | query params | n/a | none | `{cases}` |
| `/api/student/cases/[id]` | GET | `student:case:view` + verified | own attempt only | n/a | n/a | `student.case.opened` | `{attemptId,mode,view,studentTrack}` |
| `/api/student/cases/[id]/action` | POST | `student:case:attempt` + verified | own attempt only (checked) | manual (action union) | n/a (engine is pure, DB write is single-row update) | `student.case.action` | `{view,reveal,error,nextStagePreview}` |
| `/api/student/cases/[id]/submit` | POST | `student:case:submit` + verified | own attempt only (checked) | manual | n/a | `student.case.submitted` | `{attemptId,score,debrief,newAchievements,xpGain}` |
| `/api/student/dashboard` | GET | `student:progress:view` + verified | own data only | n/a | n/a | none | aggregated object |
| `/api/student/progress` | GET | `student:progress:view` + verified | own data only | n/a | n/a | none | aggregated object |
| `/api/student/notebook` | GET/POST/DELETE | `student:notes:create` + verified | own rows only | manual | n/a | none | `{entries}` / `{entry}` / `{ok}` |
| `/api/student/rxlab/validate` | POST | `student:rx:simulate` + verified | n/a | manual | n/a | none | `{warnings,context}` |
| `/api/student/viva` | POST | `student:ai:tutor` + verified | n/a | manual | n/a | none | `{question,isFromBank,complete}` / `{feedback}` |
| `/api/educator/cases` | GET/POST | `educator:case:review`/`create` | n/a (global list) / own authored | Zod (`CreateCaseSchema`) | n/a | `educator.case.created` | `{cases}` / `{case}` |
| `/api/admin/verifications/students` | GET/PATCH | `admin:verification:manage` | n/a (platform-wide by design) | manual | n/a | `student.verification.approved/rejected`, `admin.verification.reviewed` | `{applications}` / `{status}` |
| `/api/hospital/command-center` | GET | `hospital:command-center:view` | facility-derived | n/a | n/a | none | aggregated snapshot |
| `/api/hospital/beds` | GET | `patient:read` | facility-derived | n/a | n/a | none | `{beds}` |
| `/api/hospital/beds/[id]/transition` | POST | `bed:manage` | facility checked on load | manual | single-row + event (via `transitionBed`, its own tx) | `hospital.bed.stateChanged` | `{bed}` |
| `/api/hospital/beds/[id]/clean` | POST | `bed:manage` | facility checked on load | n/a | single-row + event | `hospital.bed.cleaned` | `{bed}` |
| `/api/hospital/patients` | GET/POST | `patient:read`/`write` | facility-derived | Zod (`RegisterSchema`) | n/a | `hospital.patient.registered` | `{patients}` / `{patient}` |
| `/api/hospital/patients/[id]/chart` | GET | `patient:read` | facility checked on load | n/a | n/a (5 parallel reads) | none | full chart object |
| `/api/hospital/encounters` | GET/POST | `encounter:read`/`create` | facility-derived | Zod (`CreateEncounterSchema`) | n/a | `hospital.encounter.registered` | `{encounters}` / `{encounter}` |
| `/api/hospital/encounters/[id]` | PATCH | `encounter:triage` | facility checked on load | manual (triage level range) | n/a | `hospital.encounter.updated` | `{encounter}` |
| `/api/hospital/encounters/[id]/vitals` | POST | `vital:record` | facility checked on load | manual | n/a | `hospital.vital.recorded` | `{vital}` |
| `/api/hospital/encounters/[id]/notes` | POST | `clinical:note:create` | facility checked on load | manual | n/a (2 sequential writes, not wrapped in `$transaction`) | `hospital.note.created` | `{note}` |
| `/api/hospital/orders/medication` | GET/POST | `patient:read` / `clinical:order:medication` | facility-derived | manual | n/a | `hospital.medication.ordered` | `{orders}` / `{order,flags}` or `{blocked,flags}` |
| `/api/hospital/orders/medication/[id]/administer` | POST | `medication:administer` | facility checked on load | manual | n/a | `hospital.medication.administered` | `{administration}` |
| `/api/hospital/orders/lab` | GET/POST | `patient:read` / `clinical:order:lab` | facility-derived | manual | n/a | `hospital.lab.ordered` | `{orders}` / `{order}` |
| `/api/hospital/orders/lab/[id]/result` | POST | `lab:result:enter` | facility checked on load | manual | **yes** (`$transaction`) | `hospital.lab.resultReleased` | `{result}` |
| `/api/hospital/orders/lab/[id]/acknowledge` | POST | `lab:result:acknowledge` | facility checked on load | n/a | n/a | `hospital.lab.criticalResultAcknowledged` | `{result}` |
| `/api/hospital/orders/imaging` | GET/POST | `patient:read` / `clinical:order:imaging` | facility-derived | manual | n/a | `hospital.imaging.ordered` | `{orders}` / `{order}` |
| `/api/hospital/orders/imaging/[id]/report` | POST | `imaging:report:enter` | facility checked on load | manual | **yes** (`$transaction`) | `hospital.imaging.reportEntered` | `{report}` |
| `/api/hospital/orders/imaging/[id]/verify` | POST | `imaging:report:verify` | facility checked on load | n/a | n/a | `hospital.imaging.criticalReportVerified` | `{report}` |
| `/api/hospital/admissions` | GET/POST | `encounter:read` / `admission:create` | facility-derived / checked on load | manual | **yes** (via `admitPatient()`) | `hospital.admission.created` | `{admissions}` / `{admission}` |
| `/api/hospital/admissions/[id]/transfer` | POST | `admission:transfer` | facility checked on load | manual | **yes** (via `transferPatient()`) | `hospital.admission.transferred` | `{transfer}` |
| `/api/hospital/admissions/[id]/discharge` | GET/POST/PATCH | `encounter:read` / `admission:discharge:initiate` (both POST+PATCH) | facility checked on load | manual (flag whitelist) | n/a | `hospital.discharge.initiated` (POST only) | `{discharge}` |
| `/api/hospital/admissions/[id]/discharge/finalize` | POST | `admission:discharge:finalize` | facility checked on load | n/a | **yes** (via `finalizeDischarge()`) | `hospital.discharge.finalized` | `{discharge}` |
| `/api/hospital/billing/[encounterId]` | GET/POST | `billing:view` / `billing:charge:create` | facility checked on load | manual | **yes** (`$transaction`, charge + bill upsert) | `hospital.billing.chargeCreated` | `{encounter,charges,bill}` / `{charge,bill}` |
| `/api/hospital/nurse/tasks` | GET | `patient:read` | facility-derived | n/a | n/a (2 parallel reads) | none | `{medicationTasks,vitalsTasks}` |

## 3. Validation pattern inconsistency

Two validation approaches coexist within Hospital OS/Scholar itself:

- **Zod schemas** (`RegisterSchema`, `CreateEncounterSchema`,
  `CreateCaseSchema` in educator/patients/encounters routes) — the more
  rigorous pattern, gives structured `issues` back on failure.
- **Manual `if (!field) throw new BadRequestError(...)` checks** — used in
  the majority of routes (all order routes, notes, vitals, discharge flag
  updates, billing charges). Functionally adequate for the required-field
  checks performed, but inconsistent with the Zod pattern used elsewhere,
  and doesn't validate *types* beyond presence (e.g. `amount` in the
  billing charge route is checked with `typeof amount !== "number"`
  manually rather than a Zod `z.number()` — works, but is bespoke per
  route rather than declarative).

**Recommendation for Phase 1**: standardize on Zod for every route body,
not just the three that currently use it — mechanical, low-risk, would
close several small validation gaps for free (e.g. no format validation
on `Bed.genderRestriction`, no enum validation on free-text `category`
fields beyond what TypeScript's structural typing catches at compile
time only).

## 4. Two routes outside the shared pattern

`/api/chat` and `/api/admin-auth` predate `withApiErrors`/`require*` and
are hand-rolled. Neither is a security gap on its own terms (`/api/chat`
requires no auth by original design — it's the original Patient/Doctor
prototype's AI assistant, itself unauthenticated per `docs/SECURITY_AUDIT.md`
S-01; `/api/admin-auth` does check credentials, just doesn't issue a
session — also S-01) but they are the only two API routes in the entire
`src/app/api/` tree that don't follow the now-established
error-handling/response-shape convention. Worth normalizing when/if these
routes are touched again (not urgent enough to justify touching working
code purely for consistency this phase, per the "no cosmetic rewrites"
instruction).

## 5. Transaction usage — correctly applied, not over-applied

Every route that performs more than one related write uses
`$transaction` **except** `/api/hospital/encounters/[id]/notes` (creates
a note, and — only when amending — updates the old note's status to
`SUPERSEDED` first; these are two sequential, non-transactional writes).
This is a real, if minor, gap: a crash between the two writes would leave
the old note still `SIGNED` and a new note also present, rather than
cleanly superseded. Low risk (no partial-failure has been observed, the
window is a single Prisma round-trip), worth wrapping in `$transaction`
as a small Phase 1 cleanup.

Routes that read multiple things in parallel (`Promise.all`) rather than
transact are correctly *not* using `$transaction` for that — those are
reads, not writes, and don't need atomicity (patient chart, nurse tasks,
command center snapshot).

## 6. Response shape consistency

Every route returns a plain JSON object (never a bare array, never a
top-level primitive) — good, consistent, easy to version later. Field
naming is consistent (`camelCase` throughout, no route mixing
`snake_case`). Error responses are consistently `{error: string}`,
occasionally with an added `issues` array (Zod-validated routes only) or
domain-specific fields (`{blocked: true, flags: [...]}` for the
medication-safety-block case — a deliberate, documented non-error 200
response used to distinguish "blocked, needs an override" from a hard
failure, verified live during Hospital OS testing).

## 7. What's missing across the board

- No API versioning (`/api/v1/...`) — acceptable for a single-consumer
  first-party frontend at this stage, would need addressing before any
  external/partner API consumer.
- No OpenAPI/schema documentation generated from any of this — the route
  table above is the closest thing that exists; Zod schemas could
  generate one relatively cheaply in a later phase.
- No pagination on any list endpoint beyond a hardcoded `take: N` cap
  (e.g. `take: 50`/`take: 100` scattered across routes) — fine at demo
  data volumes, a real gap once case/patient/order counts grow.
