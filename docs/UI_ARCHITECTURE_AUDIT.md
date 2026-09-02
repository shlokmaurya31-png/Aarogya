# UI Architecture Audit — Phase 0

Inspection of all major UI systems for duplication, inconsistency,
client/server boundary problems, and incomplete workflows. This is a
documentation pass only — no redesign performed, per the Phase 0
instruction.

## 1. Navigation systems — four independent implementations

| System | Component | Pattern | Notes |
|---|---|---|---|
| Patient/Doctor prototype | `src/components/navigation/TopBar.tsx` | Top bar, mode toggle (patient/doctor), tab strip driven by `useUiStore` | Has 2 pre-existing ESLint errors (`react-hooks/set-state-in-effect`, unrelated to any work this session) — see `docs/SECURITY_AUDIT.md` is not the place, noted here: `TopBar.tsx:118` |
| Original admin panel | `src/components/admin/AdminSidebar.tsx` | Left sidebar, role-conditional items (`admin` vs `staff`) | Gained one cross-linked item to Hospital OS's admin surface (`/admin/student-verifications`) this session — the one place the old and new systems' navigation touch |
| Aarogya Scholar | `src/components/student/ScholarShell.tsx` | Left sidebar, single fixed item set (not role-conditional — Scholar has only one authenticated role type, `STUDENT`) | Separate mobile drawer implementation from the desktop sidebar (duplicated markup, not a shared responsive component) |
| Aarogya Hospital OS | `src/components/hospital-os/HospitalShell.tsx` | Left sidebar, **role-conditional nav array** (`NAV_BY_ROLE`) | The most correct implementation of "role-specific navigation" (brief §115) — the other three systems don't do this as cleanly |

**Finding**: four separate sidebar/navigation implementations, no shared
`<AppShell>` primitive. Each was built for its own system at a different
time, each duplicates the "brand mark + user badge + nav list + logout"
shape with different markup. Not a bug — each system needed to exist
independently at the time it was built — but a real consolidation
opportunity flagged for a later UI-unification phase, not attempted here
per the "don't redesign yet" instruction.

## 2. Design token consistency

All four systems **do** share the same underlying design tokens
(`globals.css` custom properties → `--color-*` via `@theme inline`,
`Card`/`StatusPill`/`CardLabel` from `src/components/ui/`) — this is
consistently good. Scholar and Hospital OS both reused the existing
`Card`/`StatusPill` primitives rather than inventing new ones, confirmed
by import audit (`grep -rl "from \"@/components/ui/Card\""` returns hits
across all four systems). Color usage for status/severity
(emerald/amber/red/cyan) is applied consistently by convention, not by a
shared enum-to-color mapping function — each component hand-picks the
tone prop per status string, so a new status value added to one system
doesn't automatically get a sensible color anywhere else.

## 3. Duplicated "patient card" / "patient list" UI

At least four different patient-list/patient-card renderings exist with
no shared component:

1. `src/components/hospital/PatientsTab.tsx` (672 lines — original mock
   hospital portal's admission list).
2. `src/components/hospital-os/AdmissionsWorklist.tsx` (Hospital OS's real
   admission list).
3. `src/components/hospital-os/DoctorWorkspace.tsx` (Hospital OS's
   encounter list, patient-centric).
4. `src/components/student/CaseFeed.tsx` (Scholar's *educational patient*
   card — a fundamentally different kind of "patient," see
   `docs/IMPLEMENTATION_INVENTORY.md` §9 duplication table).

Each renders broadly the same visual shape (name, identifier, a couple of
status pills) with independently written JSX. A shared `<PatientCard>` /
`<PatientListItem>` component would reduce this, but only for the two
that represent the *same* underlying concept (#1 and #2 — both are real
hospital patients; #3 is the same data, different list shape; #4 is
intentionally a different concept and should **not** share a component
with the others, since accidentally sharing UI between "real hospital
patient" and "fictional educational patient" is exactly the kind of
confusion the privacy architecture goes out of its way to prevent — see
`docs/CLINICAL_EDUCATION_PRIVACY.md`).

## 4. Client/server boundary

- **Scholar and Hospital OS**: consistent pattern — `page.tsx` files are
  Server Components performing the auth guard (`getCurrentUser()` +
  `redirect()`), rendering a `"use client"` component that fetches its
  own data via `fetch()` from the corresponding API route. This is a
  deliberate, consistently-applied choice (not everything is
  `"use client"` — confirmed by checking every `layout.tsx` and
  `page.tsx` under `student/` and `hospital-os/`: all guard logic is
  server-side, all interactive data-fetching is client-side).
- **Original Patient/Doctor/Hospital/Admin systems**: almost entirely
  `"use client"` top-to-bottom, including the auth check itself (a
  `useEffect` that redirects if `useAuthStore.user` is absent — this is
  the UI-layer symptom of `docs/SECURITY_AUDIT.md` S-01: the guard is
  cosmetic, not a boundary).
- **One real bug found and fixed this session** in the newer pattern: the
  Hospital OS layout guard originally wrapped `/hospital-os/login` itself,
  causing an infinite redirect loop (unauthenticated visitors to the
  login page were redirected to the login page were redirected to the
  login page...). Fixed by moving every guarded route into a
  `src/app/hospital-os/(app)/` route group, leaving `/login` as an
  unguarded sibling — the same pattern Scholar already used correctly
  (`src/app/student/(app)/` vs. sibling `/student`, `/student/verify`).
  This is exactly the kind of client/server-boundary mistake that "build
  succeeded" cannot catch — found only by actually hitting the route
  after starting the server.

## 5. Accessibility

Not systematically audited (would require a dedicated pass with
screen-reader testing, out of scope for Phase 0's architecture focus).
Spot-checked: form inputs across Scholar/Hospital OS consistently have
associated `<label>` elements; interactive elements are `<button>`, not
`<div onClick>`, throughout the code written this session. Not verified:
focus management, ARIA live regions for toast notifications, color
contrast ratios in dark mode. Flagged as an explicit gap for a later
phase, not silently skipped.

## 6. Animation usage

Framer Motion is used consistently but proportionally — the original
landing page and marketing sections are animation-heavy (by design, a
marketing site), while Scholar and Hospital OS use it sparingly (stage
transitions, progress bars, toast entry/exit) rather than decoratively.
No "excessive animation" finding in the newer systems; the original
landing page's animation density is appropriate to its purpose and out of
scope for a hospital-operations audit.

## 7. Dead buttons / incomplete workflows

Systematically checked every `<button>`/form submit in Scholar and
Hospital OS components for a working `onClick`/`onSubmit` handler wired
to a real API call — none found with a no-op handler. The original
Patient/Doctor prototype's buttons are all wired to real Zustand actions
(also not "dead," just client-only — see §1 of
`docs/IMPLEMENTATION_INVENTORY.md`). **No fake/decorative UI was found in
either newer system** — every screen built this session maps to a real,
tested API call. This was verified, not assumed, by the same live-curl
testing documented in `docs/API_AUDIT.md` and referenced in the Hospital
OS build's final report.

## 8. Fake/placeholder data in the UI layer specifically

- Original Patient/Doctor prototype: `src/lib/mock-data.ts` is openly
  static reference data, rendered as-is — not disguised as live data
  anywhere (the README has always disclosed this).
- Scholar and Hospital OS: all UI reads from `fetch()` calls against real
  API routes backed by the seeded database — no hardcoded numbers found
  in any dashboard/command-center component (verified by grep for
  suspicious literal numbers in JSX across `src/components/{student,hospital-os}/`
  — none found outside of styling/layout constants).

## 9. Summary

The newer systems (Scholar, Hospital OS) are UI-architecturally sound and
consistent *within themselves*, and correctly avoid the "beautiful UI
with no real system behind it" failure mode this audit was specifically
asked to check for. The cross-system inconsistency (four navigation
shells, four patient-list renderings, two client/server boundary
philosophies) is real but expected given each system was built
independently to avoid breaking the others — it is the natural
consequence of the duplication documented in
`docs/IMPLEMENTATION_INVENTORY.md` §9, not a new finding. Consolidation
belongs to the unification phase in `docs/IMPLEMENTATION_ROADMAP.md`, not
Phase 0.
