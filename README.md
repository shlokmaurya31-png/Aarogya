# Aarogya AI

India's unified health intelligence platform: one permanent health record for every patient, read by AI, verified by labs, and understood by every doctor they'll ever meet.

Aarogya AI is a prototype health-record and clinical-workflow platform connecting **patients**, **doctors**, **hospitals**, **labs**, and **insurers** around a single longitudinal record. It ships as a cinematic marketing site plus a fully interactive command-center dashboard with separate patient and doctor experiences — plus three newer, database-backed systems built on a **unified clinical core**: **Aarogya Scholar** (a medical-education ecosystem for verified healthcare students — see [`docs/STUDENT_PLATFORM_ARCHITECTURE.md`](docs/STUDENT_PLATFORM_ARCHITECTURE.md), intentionally isolated from real clinical data), **Aarogya Hospital OS** (a real, multi-facility hospital operations platform — see [`docs/ENTERPRISE_HOSPITAL_ARCHITECTURE.md`](docs/ENTERPRISE_HOSPITAL_ARCHITECTURE.md)), and a **Patient self-service portal** reading the same longitudinal record Hospital OS's doctors write to (see [`docs/CLINICAL_CORE.md`](docs/CLINICAL_CORE.md)).

## Features

- **Dual-mode dashboard**: switch between a Patient view (health score, medicines, appointments, AI assistant) and a Doctor view (clinical summary, SOAP briefs, lab results, prescriptions) from one toggle.
- **AI health assistant**: a chat-style panel where patients can ask questions, get voice input (Web Speech API), and upload a health record for the AI to "analyze"; the resulting summary is added to the patient's Reports and surfaces on the doctor's side too.
- **Doctor-authored prescriptions**: a form doctors fill with their name/registration/facility once and reuse, issuing new prescriptions that show up live in the patient's Medicines view.
- **Emergency SOS, appointment booking, refill requests, report downloads, and directions/video-call actions**: all wired to real client-side state and feedback (toasts), not static mockups.
- **Multi-language dashboard**: a language switcher in the top bar translates the UI into English, Hindi, Bengali, Marathi, Telugu, Tamil, Gujarati, Urdu, Kannada, Odia, and Malayalam (with automatic RTL for Urdu).
- **Cinematic landing page**: an animated hero with a scrubbable background video, staggered-word headline, and sections covering the platform's features, AI diagnosis, timeline, pricing, and FAQ.

## Tech stack

- [Next.js 16](https://nextjs.org) (App Router) + React 19 + TypeScript
- [Tailwind CSS 4](https://tailwindcss.com) with a custom design-token system (light theme)
- [Framer Motion](https://www.framer.com/motion/) for animation, [Lenis](https://github.com/darkroomengineering/lenis) for smooth scroll
- [Zustand](https://github.com/pmndrs/zustand) for shared client state (UI mode, records, prescriptions, toasts, language) — used by the original Patient/Doctor prototype
- [Prisma](https://www.prisma.io) + SQLite for Aarogya Scholar's persistence (real accounts, verification, case attempts, scoring, competencies)
- [Recharts](https://recharts.org) for vitals/competency charts, [lucide-react](https://lucide.dev) for icons
- [React Three Fiber](https://docs.pmnd.rs/react-three-fiber) / drei (available for 3D work, not currently on the critical path)
- [Vitest](https://vitest.dev) for unit tests (RBAC, de-identification, scoring, case engine, RxLab rules)

## Getting started

```bash
npm install
npx prisma migrate dev   # creates prisma/dev.db and applies the Scholar schema
npm run db:seed          # seeds demo accounts + 25 synthetic teaching cases
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for the landing page,
[http://localhost:3000/dashboard](http://localhost:3000/dashboard) for the Patient/Doctor prototype,
[http://localhost:3000/student](http://localhost:3000/student) for **Aarogya Scholar**,
[http://localhost:3000/hospital-os/login](http://localhost:3000/hospital-os/login) for **Aarogya Hospital OS**, or
[http://localhost:3000/patient/login](http://localhost:3000/patient/login) for the **patient self-service portal**.

Other scripts:

```bash
npm run build      # production build
npm run start      # serve the production build
npm run lint        # run ESLint
npm run test        # run the Vitest suite
npm run db:migrate  # create/apply a new Prisma migration
npm run db:seed     # re-seed demo accounts + synthetic cases (idempotent)
npm run db:studio   # browse the local database
```

### Aarogya Scholar demo accounts (dev only — password `Scholar@123` for all)

| Email | Role |
|---|---|
| `student@demo.aarogya` | Verified MBBS final-year student |
| `student.firstyear@demo.aarogya` | Verified MBBS first-year student |
| `student.nursing@demo.aarogya` | Verified BSc Nursing student |
| `student.pharmacy@demo.aarogya` | Verified PharmD student |
| `educator@demo.aarogya` | Educator (case authoring) |
| `admin@demo.aarogya` | Aarogya Scholar admin (student verification review) |
| `doctor@demo.aarogya` | Placeholder for a future Patient/Doctor migration onto this auth system |

## Aarogya Scholar

A medical-education ecosystem layered onto the existing Patient/Doctor prototype for **verified healthcare students** — MBBS, BDS, nursing, pharmacy, physiotherapy, diagnostics, and public health. Students work through a server-authoritative case engine (history → examination → differential → investigations → diagnosis → management → prescription → viva → debrief) built on 25 distinct synthetic teaching cases, with deterministic rubric scoring, an RxLab prescription simulator, an AI-backed (with deterministic fallback) viva examiner, and competency/progress analytics.

Full design: [`docs/STUDENT_PLATFORM_ARCHITECTURE.md`](docs/STUDENT_PLATFORM_ARCHITECTURE.md).
Privacy architecture: [`docs/CLINICAL_EDUCATION_PRIVACY.md`](docs/CLINICAL_EDUCATION_PRIVACY.md).
Threat model: [`docs/STUDENT_PLATFORM_THREAT_MODEL.md`](docs/STUDENT_PLATFORM_THREAT_MODEL.md).
Future real-data integration (architecture only — not implemented): [`docs/REAL_CLINICAL_DATA_INTEGRATION.md`](docs/REAL_CLINICAL_DATA_INTEGRATION.md).

**Privacy disclaimer**: every case in this build is synthetic/fictional (`CLINICAL_DATA_MODE=synthetic` is the only implemented mode — see `src/lib/clinical/config.ts`). There is no code path to a real clinical data source. Verification documents are stored in a restricted, gitignored local directory (`.data/verification-uploads/`), never served by any route, and never shown in a student's own profile.

**Educational disclaimer**: Aarogya Scholar is for education and simulation only, not for direct patient-care decisions. RxLab prescriptions are watermarked "EDUCATIONAL SIMULATION — NOT A VALID PRESCRIPTION" and carry no legal prescribing weight. Achievements and the Clinical Passport are gamified learning artifacts, not formal medical credentials or licenses.

### Environment variables

See [`.env.example`](.env.example). New variables added for Scholar: `DATABASE_URL`, `AUTH_SECRET`, `CLINICAL_DATA_MODE`, `AI_PROVIDER`, `ENABLE_DEV_VERIFICATION`.

## Aarogya Hospital OS

A real, database-backed hospital operations platform under `/hospital-os` — tenancy (Organization → Facility → Department → Ward → Bed), a longitudinal patient/encounter record spanning OPD/ED/IPD, transactional bed admission/transfer/discharge (every state change writes an auditable `BedStateEvent`), a Doctor Workspace with order entry (medication/lab/imaging) and allergy/duplicate-medication safety checks, a Nursing task engine with a real medication administration record, Lab and Radiology order→result/report queues with critical-value acknowledgement workflows, a billing charge engine, and a Hospital Command Center whose every widget — including the alert feed — is computed live from the database, not decorative.

Full design, phasing, and what's deliberately deferred: [`docs/ENTERPRISE_HOSPITAL_ARCHITECTURE.md`](docs/ENTERPRISE_HOSPITAL_ARCHITECTURE.md).
Threat model: [`docs/HOSPITAL_THREAT_MODEL.md`](docs/HOSPITAL_THREAT_MODEL.md).

**Important**: this lives at `/hospital-os`, not `/hospital` — the existing `/hospital` route is a separate, working, client-side (Zustand) hospital-admin portal for the original `hospital` auth role, left untouched. See the architecture doc §1.1 for why.

Demo login: [http://localhost:3000/hospital-os/login](http://localhost:3000/hospital-os/login) — accounts below, password `Hospital@123` for all. Two facilities exist under one demo `Organization`, each independently tenant-isolated (verified: a Pune account gets a `404`, not another facility's data, on every cross-facility patient lookup — see [`docs/CLINICAL_CORE.md`](docs/CLINICAL_CORE.md) §6/Phase 1 final report):

| Email | Role | Facility |
|---|---|---|
| `admin@amc-demo.aarogya` | Hospital Administrator | Pune |
| `doctor1@amc-demo.aarogya` … `doctor8@amc-demo.aarogya` | Doctors (Cardiology, Orthopedics, General Medicine, Pediatrics, Emergency Medicine, Neurology, General Surgery, OB/GYN) | Pune |
| `nurse1@amc-demo.aarogya` … `nurse10@amc-demo.aarogya` | Nurses | Pune |
| `labtech@amc-demo.aarogya` | Lab Technician | Pune |
| `radtech@amc-demo.aarogya` | Radiology Technician | Pune |
| `pharmacist@amc-demo.aarogya` | Pharmacist | Pune |
| `billing@amc-demo.aarogya` | Billing Officer | Pune |
| `admin@noida-demo.aarogya` | Hospital Administrator | Noida |
| `doctor1@noida-demo.aarogya` | Doctor (Orthopedics) | Noida |
| `frontdesk@amc-demo.aarogya` | Front Desk Coordinator (Phase 2) | Pune |

## Aarogya Patient Flow / ADT (Phase 2)

Turns the clinical core into a usable Access + OPD + Emergency + ADT
system: registration desk with duplicate-aware patient search, doctor
scheduling and appointment booking with real slot/conflict checking, a
database-backed priority queue engine (front desk, triage, OPD, ED — one
`QueueEntry` table, deterministic non-AI priority scoring), structured ED
triage with a live ED board, and an admission-request → bed-matching →
reservation → confirmation workflow plus an internal-transfer-request
workflow layered on top of the existing bed/admission machinery (never
duplicated). Discharge gained a computed barrier engine that tells staff
*why* a patient hasn't left (pending lab/imaging, unacknowledged critical
result, billing/insurance/pharmacy/transport) instead of just *that*
discharge is pending. Full reasoning: [`docs/PATIENT_FLOW.md`](docs/PATIENT_FLOW.md),
[`docs/ADT_ARCHITECTURE.md`](docs/ADT_ARCHITECTURE.md),
[`docs/OPD_WORKFLOW.md`](docs/OPD_WORKFLOW.md),
[`docs/EMERGENCY_WORKFLOW.md`](docs/EMERGENCY_WORKFLOW.md).

## Aarogya Unified Clinical Core (Phase 1)

Built on top of Hospital OS's schema: one `Patient` → many `Encounter`s →
many clinical facts (`Diagnosis`, `Problem`, `Allergy`, `Vital`,
`ClinicalNote`, orders), aggregated at request time into a real
server-side Patient Summary and a clickable Longitudinal Timeline —
consumed by both the Doctor Workspace's patient chart and a new patient
self-service portal at `/patient/login`. Adds deterministic (non-fuzzy)
duplicate-patient detection with a safe, non-destructive logical merge
(never deletes clinical rows), a controlled encounter state-transition
service (illegal transitions like `CLOSED → IN_CONSULTATION` are rejected
server-side), signed/amendable clinical notes (a signed note is never
mutated — an amendment is a new note superseding the old one), and
foundational `Task`/`Document`/`Consent`/`Referral`/`EpisodeOfCare`
entities. Full reasoning for every design decision, including where the
brief's idealized target model was deliberately not adopted in favor of
the existing working schema: [`docs/CLINICAL_CORE.md`](docs/CLINICAL_CORE.md).

**Aarogya Scholar is deliberately not part of this unification** — it
remains fully isolated from real hospital clinical data behind its
existing Clinical Learning Data Gateway / de-identification architecture;
see `docs/CLINICAL_CORE.md` §7.

## Project structure

```
src/
  app/                     # Next.js routes
    student/                # Aarogya Scholar: landing, verify, and the authenticated app shell
    educator/                # Educator case list + minimal authoring
    admin/                   # Existing Patient/Doctor admin panel + /admin/student-verifications
    hospital-os/             # Aarogya Hospital OS: login + role-guarded command surfaces
    patient/                 # Patient self-service portal: login + guarded (app) route group
    api/
      student/, educator/, admin/, scholar-auth/   # Scholar API routes
      hospital/                                     # Hospital OS API routes (includes Phase 1 clinical-core routes)
      patient/                                       # Patient self-service API routes (register, me)
      admin-auth/, chat/                            # original Patient/Doctor API routes
    dashboard/, hospital/, lab/, login/, onboarding/, prescriptions/, settings/   # original Patient/Doctor routes
  components/
    student/                # Scholar UI: dashboard, case workspace, RxLab, viva, notebook, passport, verification
    hospital-os/             # Hospital OS UI: command center, bed board, admissions, discharge, doctor/nurse/lab/radiology/billing
    patient-portal/          # Patient self-service UI: shell + longitudinal record view
    ai/, charts/, dashboard/, landing/, navigation/, patient/, shared/, timeline/, ui/, views/, admin/, auth/, hospital/   # original components
  lib/
    auth/                    # password hashing, signed-cookie sessions, RBAC, permissions, audit, tenant scoping (hospitalRbac.ts)
    privacy/                 # de-identification pipeline (Clinical Learning Data Gateway)
    clinical/                 # ClinicalCaseProvider interface + SyntheticCaseProvider + gateway
    caseEngine/               # case state machine + public-view stripping
    scoring/                  # deterministic CaseScoringEngine + competency roll-up + achievements
    rxlab/                    # prescription validation rules
    ai/                       # AIProvider abstraction (Anthropic + deterministic mock)
    verification/             # verification-document storage boundary
    hospital/                 # bed + encounter state machines, admission/transfer/discharge transactions, clinical safety checks, alert engine, command-center aggregation
    patient/                  # duplicate detection, logical merge, longitudinal timeline + summary aggregation (unified clinical core)
    i18n.ts, mock-data.ts, ...   # original Patient/Doctor helpers
  store/                    # Zustand stores (original Patient/Doctor client state — untouched)
  types/                    # shared TypeScript types (clinicalCase.ts added for Scholar)
prisma/
  schema.prisma              # shared persistence layer for Scholar + Hospital OS (SQLite dev, Postgres-portable)
  seed.ts, seedData/          # demo accounts, achievements, 25 synthetic teaching cases, demo hospital (Aarogya Medical Centre)
docs/                       # architecture, privacy, threat model, future-integration docs
```

## Notes

The original Patient/Doctor prototype is built on mock data with **no backend**: all "records," "prescriptions," and "AI analysis" are simulated client-side via Zustand, and translations are hand-written. Both should be reviewed before any real clinical or production use.

Aarogya Scholar, added alongside it, introduces this repository's **first real backend** (Prisma + SQLite, hashed passwords, signed sessions, server-side RBAC) — but only for the student/educator/admin surfaces described above. The two systems currently run side by side rather than being unified; see `docs/STUDENT_PLATFORM_ARCHITECTURE.md` §2.10 for the migration path.
