# Aarogya Component Inventory

Current shared components and the target hierarchy. Principle: **extract components
from real repetition; fix the component instead of cloning a variant.**

## Current state

`src/components/ui/` is thin for the app's size - **6 files** against ~65 routes:
`Autocomplete`, `Card`, `SectionHeader`, `StatusPill`, `demo`, `saa-s-template`.
Most primitives (buttons, inputs, selects, tables) are re-implemented inline per page
with arbitrary classes - the root cause of the drift in [`ux-audit.md`](./ux-audit.md).

Domain component folders (counts): `hospital-os` 45 · `landing` 17 · `views` 15 ·
`student` 14 · `hospital` 8 · `dashboard` 5 · `shared` 5 · `charts` 2 · others 1–3.

## Target hierarchy (build only from real repetition)

### Foundation (promote from inline usage)
`Button` · `Input` · `Select` · `Textarea` · `Checkbox` · `Radio` · `Switch` ·
`Badge` · `StatusPill` (retune tones) · `Tooltip` · `IconButton` · `SegmentedControl`
(replaces inline `bg-black/[…]` toggle rows).

### Layout
`Container` · `Stack` · `Grid` · `Section` · `PageHeader` · `Sidebar` (exists in
`HospitalShell`) · `Topbar` (**new**, for mobile) · `MobileNav` (**new**) · `SplitPane`.

### Data
`DataTable` (**new**, shared dense-table) · `Stat` / `Metric` (`.type-metric`) ·
`Timeline` (folder exists) · `Chart` (recharts wrappers in `charts/`) · `List` ·
`ActivityFeed` · `Skeleton` · `EmptyState` (**new**) · `ErrorState` (**new**).

### Healthcare
`PatientHeader` / `PatientIdentityPanel` (exists) · `EncounterHeader` ·
`ClinicalStatus` · `MedicationRow` · `LabResult` · `ImagingResult` · `VitalSign`
(`.type-clinical`, `critical` token) · `AllergyAlert` / `ClinicalAlert` (`critical`) ·
`CareTeam` · `TimelineEvent`.

### Workflow
`Stepper` · `WorkflowStatus` · `TaskQueue` · `ApprovalPanel` · `ActionBar` ·
`CommandBar` · `ConfirmationDialog` · `Drawer` · `Modal`.

## Consolidation opportunities
- **Card**: retune to `rounded-surface` + `shadow-e1`; single source (currently 274
  hardcoded radii bypass it).
- **StatusPill**: keep API, remap `TONES` to semantic roles (`neutral`/`success`/
  `warning`/`danger`/`info`/`brand`).
- **Inline inputs/toggles**: extract `Input` + `SegmentedControl`, kill `bg-black/[…]`.
- **Tables**: unify per-page tables into one `DataTable` with a defined responsive mode.

## Rule
Do **not** create a component because it sounds useful. Create it when the same markup
appears ≥3× with meaningful drift. Delete `demo.tsx` / `saa-s-template.tsx` if unused.
