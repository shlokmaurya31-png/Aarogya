# Aarogya Design Debt

Prioritized, actionable inventory. Each item: location · problem · why it matters ·
solution · reusable-component opportunity · complexity (S/M/L).

## P0 - usability / safety

| # | Location | Problem | Why it matters | Solution | Reusable | Cx |
|---|----------|---------|----------------|----------|----------|----|
| 1 | 284× across `src/**` (`bg-black/[…]`) | Neutral fills paint black-on-dark, vanish in dark mode | Inputs/controls/hover lose contrast & affordance | Replace with `bg-fill-subtle/muted/hover/active` | `Input`, `SegmentedControl` | M |

## P1 - major inconsistency / workflow friction

| # | Location | Problem | Why it matters | Solution | Reusable | Cx |
|---|----------|---------|----------------|----------|----------|----|
| 2 | `HospitalShell.tsx` | No nav below `lg` | Clinicians can't navigate on tablet/mobile | Mobile topbar + drawer (reuse `NAV_BY_ROLE`) | `MobileNav`, `Topbar` | M |
| 3 | `StatusPill.tsx` + 116 cyan / 88 emerald files | Brand vs success ambiguity | One hue, two meanings misleads | Tokens done; migrate pill default→neutral, selection→`brand`, success→`success` | `StatusPill`, `Badge` | M |
| 4 | Global (`text-[12.5px]` etc.) | Un-tokenized type | Hierarchy drifts per page | Adopt `.type-*` scale | type utilities | L |

## P2 - noticeable visual / UX

| # | Location | Problem | Why it matters | Solution | Reusable | Cx |
|---|----------|---------|----------------|----------|----------|----|
| 5 | 274× `rounded-[2x]` | Radius inflation | Generic look, wasted density | `rounded-surface/panel/control` | `Card` | M |
| 6 | Worklists/dashboards | Uneven loading/empty/error states *(rendered)* | Users lack feedback/guidance | Shared `EmptyState`, `Skeleton`, `ErrorState` | yes | M |
| 7 | HOS tables | No shared dense-table pattern *(rendered)* | Inconsistent scanning & mobile | `DataTable` with defined responsive transform | `DataTable` | L |
| 8 | Interactive elements | No standard focus ring | Keyboard users lose position | Apply `.focus-ring` | helper | S |

## P3 - polish

| # | Location | Problem | Solution | Cx |
|---|----------|---------|----------|----|
| 9 | 7 files (`glass`), `.noise`, `.holo-grid` | Decorative effects risk leaking into app surfaces | Restrict to public marketing | S |
| 10 | Icon sizing | Ad-hoc sizes | Standardize 13/15/18/20 | S |

## Status
- **Done:** semantic token layer (color/fill/focus/radius/elevation/motion/type utilities)
  in `globals.css`; build verified green. Items above are additive migrations - legacy
  utilities still resolve, so debt can be paid down progressively without regressions.
- **Next:** items #1, #2, #3 (highest safety/consistency payoff) - see
  [`../design/`](./) Phase 14 ordering in the final report.
