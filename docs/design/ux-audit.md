# Aarogya UX Audit

Findings from inspecting the frontend source (tokens, `RootLayout`, `HospitalShell`,
`ui/` primitives, and route/component structure across ~203 `.tsx` files / ~65 routes).

> **Verification honesty:** this pass is **code-level and structural.** Findings marked
> *(rendered)* still need visual confirmation in a running browser at each viewport and
> in both themes. Do not treat unmarked findings as visually verified. See
> [`design-debt.md`](./design-debt.md) for the prioritized, actionable list.

## Severity legend
`P0` harms usability/safety · `P1` major inconsistency or workflow friction ·
`P2` noticeable visual/UX issue · `P3` polish.

## Findings

### P0 - Dark-mode neutral fills disappear
`bg-black/[…]` is used **284×** for input backgrounds, segmented controls, hover
states, and progress tracks. In dark mode these paint black-on-dark and become
invisible, collapsing affordances and contrast. **Fix:** migrate to `bg-fill-*`
tokens (already added). Highest-volume systemic defect.

### P1 - No navigation on tablet/mobile in Hospital OS
`HospitalShell` sidebar is `hidden lg:flex` with **no** mobile substitute (no topbar,
drawer, or bottom nav). Below `lg`, staff cannot navigate. **Fix:** add a mobile
top bar + slide-in drawer (or role-aware bottom nav) reusing the same `NAV_BY_ROLE`.

### P1 - Brand color ambiguity
Two competing accents: **cyan** (shell, `themeColor`, 116 files) and **emerald**
(`StatusPill` default tone, selection color). A single hue meaning both "brand" and
"success" misleads. **Fix (done at token level):** brand = teal/cyan; emerald = success
only. Remaining: migrate `StatusPill` default + selection tints to `brand`/`success`.

### P1 - Un-tokenized typography
Arbitrary sizes throughout (`text-[12.5px]`, `text-[11px]`, `text-[13px]`) with no
shared scale, so hierarchy drifts page to page. **Fix:** adopt `.type-*` scale.

### P2 - Radius inflation
`rounded-[2x]` appears **274×** (20–28px), the "huge rounded card" anti-pattern; reads
as generic and wastes vertical space in dense views. **Fix:** `rounded-surface` (12) /
`rounded-panel` (16) / `rounded-control` (8).

### P2 - Loading / empty / error / success states *(rendered)*
Coverage is uneven across worklists and dashboards. Each async surface needs an
intentional loading state; each empty state must say what's empty, why it matters, and
the next action; errors must be actionable (never raw technical text); important
mutations need explicit confirmation (toasts exist via `ToastViewport` - apply
consistently).

### P2 - Table density & responsive behavior *(rendered)*
Hospital OS is table-heavy (worklists, boards, queues). Needs one shared dense-table
pattern: column hierarchy, sort/filter, row actions, sticky header, and a defined
mobile transform (stack / horizontal-scroll / drawer) rather than shrink.

### P2 - Focus states
No standardized focus ring; some inputs only shift border color on focus. **Fix:**
apply `.focus-ring` (added) across interactive elements for keyboard visibility.

### P3 - Decorative effects on non-marketing surfaces
`.noise`, `.holo-grid`, `.glass` are fine on the public hero but should not leak into
clinical/app surfaces. Audit usage (glass currently in 7 files).

## Cross-cutting UX checks to run in-browser (Phase 17 loop)
Forms (validation, keyboard order, error placement, unsaved-changes guard,
destructive-action confirmation) · Tables (density, sort/filter, pagination, row
actions, responsive) · Accessibility (keyboard path, focus, contrast pairs measured,
labels/ARIA, 44px touch targets, reduced motion) · Contrast measured on the rendered
pair in both themes - never estimated.
