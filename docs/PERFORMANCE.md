# Performance: the 15 most-used screens at hospital scale

- **Status:** 2026-10-28, Flagship 1c.
- **Commands:** `npm run perf:seed` (reset `aarogya_verify`, the demo seed, then the perf seed), `npm run perf:gate` (measure; `-- --fresh` seeds first). Not part of `verify:all`.
- **Code:** `scripts/perf-seed.ts`, `scripts/perf-gate.ts`; the report goes to `.perf-report/latest.md`.

## The data

One year of a 200-bed hospital at the Pune demo facility, synthetic and deterministic, written by set-based SQL into the local verify database only (the gate guard refuses any other):

| What | Rows |
|---|---|
| Patients | 40,000 |
| Encounters (OPD 45,000 · ED 6,000 · IPD 9,000; about 150 inpatients and 20 ED patients now) | 60,000 |
| Beds | 200 |
| Orders: lab (with 203,000 results) · imaging · medication | 204,000 · 27,000 · 78,000 |
| MAR doses · vitals · nursing tasks | 216,000 · 171,000 · 90,000 |
| Diagnoses · clinical notes | 60,000 · 87,000 |
| Billing accounts · charges | 60,000 · 294,000 |
| Appointments · queue entries | 47,000 · 45,000 |
| Domain events (processed history) | 1,000,000 |
| People's uploads (processed, with 40,000 extracted facts) | 5,040 |
| Indexed record chunks (1024-dimension embeddings) | 50,000, plus the perf patient's own record indexed through the real indexer (2,344 sources) |
| Listed doctors (through the real services) | 150 |

Through the real services it also creates the people the gate signs in as: a patient with a heavy record (120 visits mixing OPD, ED and IPD, with about 600 orders), 40 uploads awaiting review, a household of four, and 60 of today's pre-arrival check-ins.

## The method

`perf:gate` builds the app, starts `next start` (production) on the verify database with the mock providers, signs in as the role that uses each screen, and calls each API one request at a time: 3 warm-ups, then 40 calls. The budget is **p95 ≤ 300 ms** per endpoint, and every call must answer 200. The AI endpoints rotate the eight demo doctors, because staff may ask 20 questions a minute each.

The numbers are from a laptop (Postgres 16 in Docker under Colima, Apple Silicon). They are a regression gate, not a capacity test: one user at a time, no network between app and database.

## Results (40 calls each)

| Screen / API | Endpoint | p95 before (ms) | p95 after (ms) |
|---|---|---|---|
| Front desk search | `GET /api/hospital/patients?q=` | 73.8 | 66.9 |
| Chart | `GET /api/hospital/patients/[id]/chart` | 48.4 | 45.0 |
| Doctor workspace | `GET /api/hospital/doctor/dashboard` | **171.8** | **36.5** |
| Nurse MAR (the medication round) | `GET /api/hospital/nurse/tasks` | 68.3 | 67.9 |
| ED board | `GET /api/hospital/ed/board` | 37.6 | 33.8 |
| Command centre | `GET /api/hospital/command-center/overview` | **279.1** (max 469) | **95.7** (max 118) |
| Billing (an inpatient stay) | `GET /api/hospital/billing/[encounterId]` | 18.3 | 26.5 |
| Patient portal home | `GET /api/patient/home` | 45.3 | 53.7 |
| Timeline | `GET /api/hospital/patients/[id]/timeline` | **109.9** | **39.1** |
| Visit brief (AI) | `POST /api/ai/ask` (VISIT_BRIEF) | 280.9 (noisy: 179–281 across three runs) | 194.0 |
| Directory search | `GET /api/doctors/search` | 64.1 | 62.9 |
| Check-in desk | `GET /api/hospital/checkins` | 34.7 | 40.1 |
| AI ask (retrieval) | `POST /api/ai/ask` (CHART_QA) | 214.8 | 218.2 |
| Document review (facts to confirm) | `GET /api/patient/person/facts` | 27.5 | 33.0 |
| Household switcher | `GET /api/patient/household` | 24.1 | 32.6 |

Nothing was over 300 ms at p95 before the fixes, but the command centre (279 ms, a 469 ms maximum) and the visit brief were within noise of the budget, and the four slowest reads grow with history. Differences of a few milliseconds between the columns are run-to-run noise.

## What was fixed

Found with the database's slow-statement log during a gate run:

1. **Two all-time counts on every dashboard load.** `getDiagnosticsOperationalCounts` counted every lab and imaging order the facility had ever had (`labOrdersToday`, `imagingOrdersToday`: named "today", counting all time) through a join to the encounter. Nothing read them. Removed.
2. **Pending orders scanned the whole history.** `status NOT IN ('RESULTED','CANCELLED')` through the encounter join could not use the status index. It is now the equivalent `status IN (…)` list (every status but the final ones, derived from the enum), which uses it.
3. **The command centre computed the diagnostics snapshot twice** (its laboratory and radiology sections). Once per request now (`diagnosticsFor(ctx)`).
4. **Missing indexes** (migration `20261028180000_flagship_perf_indexes`, additive): `LabOrder(patientId, orderedAt)` and `ImagingOrder(patientId, orderedAt)` (the timeline and chart read a patient's orders by patient: full scans before), `LabResult(status, isCurrent)` (results awaiting verification), `ClinicalNote(status, authorStaffId)` (unsigned notes per doctor).

## Watch next

- **Payload size:** the chart answers 451 KB and the timeline 331 KB for the heavy patient (50 of each kind, 120 encounters; about 2,000 timeline entries). Fine on Wi-Fi, slow on a ward's weak signal: paginate both before the offline nursing work (docs/OFFLINE_NURSING_DESIGN.md).
- **Front desk search** is an `ILIKE` over names (67 ms at 40,000 patients). A trigram index is the remedy past a few hundred thousand.
- **The AI endpoints** spend most of their time in retrieval (an exact cosine scan, by design; docs/RAG_DESIGN.md §3.2a) and the mock answer. With a real model, the model's latency dominates and streaming hides it; the budget here covers the server's own work.
- **Concurrency:** this gate is one user at a time. A load test with concurrent users (the OPD morning rush) is separate work.
