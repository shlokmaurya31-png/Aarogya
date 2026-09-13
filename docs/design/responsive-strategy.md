# Aarogya Responsive Strategy

Mobile is not an afterthought and not a shrunk desktop. Layouts **hold their expanded
form until the content genuinely stops fitting, then collapse deliberately.**

## Breakpoints
Content-driven, expressed with Tailwind defaults where they match real break points:
`sm` 640 · `md` 768 · `lg` 1024 · `xl` 1280. Prefer container queries for
component-level adaptation. Test smallest and largest first. Layout margins:
`px-4` → `sm:px-6` → `lg:px-8`.

## Per-surface behavior

| Surface | Desktop | Tablet | Mobile |
|---------|---------|--------|--------|
| **Hospital OS shell** | Sidebar (`w-232`) | **Drawer via topbar** (new) | **Drawer + topbar** (new) |
| Worklists / boards | Dense table | Horizontal-scroll in `overflow-x-auto` container | Card/stack rows or drawer detail |
| Patient header | Full inline | Wrapped, key IDs kept | Sticky compact identity bar |
| Forms | Multi-column groups | 1–2 col | Single column, 16px inputs |
| Dashboards | Grid of stat/metric | 2-col grid | Stacked, priority-first |
| Modals | Centered `shadow-e3` | Centered | Full-screen or bottom sheet |
| Drawers | Side | Side | Bottom sheet |
| Command bar | Inline `⌘K` | `⌘K` | Full-screen search |
| Public site | Full narrative | Reflowed | Stacked, single column |

## Component transforms
- **Tables** never shrink text to fit. Choose per table: (a) horizontal scroll inside
  an `overflow-x-auto` wrapper (page never scrolls sideways), (b) stack to labeled
  rows, or (c) master-list + detail drawer. Boards (ED/ICU/OT/beds) → stacked columns
  or swipeable lanes.
- **Sidebar → drawer** below `lg` (the current P1 gap).
- **Multi-column forms → single column**; keep field grouping and error placement.
- **Sticky chrome** (patient identity, action bars) floats above content and respects
  `env(safe-area-inset-*)`; never park a critical action where scrolling clips it.

## Rules
- Full-width buttons stay inset within layout margins with visible radius.
- Content/media may bleed to viewport edges; controls and text stay within margins and
  safe areas.
- Touch targets ≥ 44px (see `better-accessibility`); adjacent targets don't overlap.
- Test at 200% zoom and, where relevant, RTL mirroring.
