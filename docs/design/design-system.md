# Aarogya Design System

The single source of truth for tokens. Defined in
[`src/app/globals.css`](../../src/app/globals.css) as CSS custom properties and
exposed to Tailwind v4 via `@theme inline`. **Components reference the semantic
tier only** - never a raw hex value, never a primitive.

> Migration note: the legacy color-named utilities (`text-emerald`, `text-cyan`,
> `bg-black/[…]`, `rounded-[20px]`) still resolve and are not broken. New and
> migrated code uses the semantic tokens below. See [`design-debt.md`](./design-debt.md).

---

## 1. Color

### Brand - teal
Trust, calm, clinical precision. Matches the PWA `themeColor` (`#0e7490`).

| Token | Light | Dark | Role |
|-------|-------|------|------|
| `--brand` → `text-brand` `border-brand` | `#0e7490` | `#22d3ee` | Adaptive accent: links, active nav, icons, focus |
| `--brand-strong` → `bg-brand-strong` | `#0e7490` | `#0e7490` | Constant solid fill (primary buttons) |
| `--brand-subtle` → `bg-brand-subtle` | teal 12% | cyan 14% | Tints, active-row backgrounds |
| `--on-brand` → `text-on-brand` | `#ffffff` | `#ffffff` | Foreground on `brand-strong` |

**One primary action per view** gets `bg-brand-strong`; peers stay neutral.
Put brand color on the *background* of the primary action, not the label.

### Status - one hue, one meaning
| Role | Token / utility | Light | Dark | Use |
|------|-----------------|-------|------|-----|
| Success | `--success` / `text-success` | `#15803d` | `#34d399` | Completed, verified, in-range |
| Warning | `--warning` / `text-warning` | `#b45309` | `#fbbf24` | Attention, degrading, due-soon |
| Danger | `--danger` / `text-danger` | `#dc2626` | `#f87171` | Errors, destructive actions |
| Info | `--info` / `text-info` | `#2563eb` | `#60a5fa` | Neutral notices (distinct from brand) |
| Critical | `--critical` / `text-critical` | `#b91c1c` | `#fca5a5` | **Life-safety** clinical alerts only |

Each has a `-dim` variant (`--success-dim`, …) for tinted backgrounds.
`critical` is reserved for patient-safety signals (allergy conflicts, code alerts,
critical vitals) so it never blurs with ordinary form errors.

### Neutrals & surfaces (existing, retained)
`--ink` (app bg) · `--surface` · `--card` · `--card-raised` · `--hairline` /
`--hairline-strong` (borders) · `--text-primary` / `--text-secondary` /
`--text-tertiary`.

### Fills - invert-safe (replaces `bg-black/[…]`)
The 284 `bg-black/[…]` overlays add black over dark surfaces and disappear in dark
mode. Use these instead - they flip to white overlays on dark:

| Utility | Light | Dark | Use |
|---------|-------|------|-----|
| `bg-fill-subtle` | black 3% | white 4% | Input backgrounds, quiet zones |
| `bg-fill-muted` | black 5% | white 6% | Segmented controls, chips |
| `bg-fill-hover` | black 4.5% | white 5% | Row/item hover |
| `bg-fill-active` | black 7% | white 8% | Pressed / selected neutral |

### Focus
`--focus` (= brand). Use the `.focus-ring` helper class → `2px` outline, `2px`
offset, inherits radius. Never remove focus outlines.

---

## 2. Typography

Family: **Inter** (`--font-sans`), **Geist Mono** (`--font-mono`) for IDs/codes.
Root has `antialiased`. Scale is role-named (utility classes in `globals.css`):

| Class | Size | Line-height | Tracking | Weight | Use |
|-------|------|-------------|----------|--------|-----|
| `.type-display` | clamp 32–52px | 1.05 | −0.02em | 600 | Marketing hero only |
| `.type-title` | 24px | 1.15 | −0.015em | 600 | Page title |
| `.type-heading` | 18px | 1.25 | −0.01em | 600 | Section / card title |
| `.type-subheading` | 15px | 1.3 | - | 600 | Sub-section |
| `.type-body` | 14px | 1.55 | - | 400 | Body |
| `.type-secondary` | 13px | 1.5 | - | - | Supporting text |
| `.type-label` | 11px | 1.2 | +0.08em | 500 | Uppercase labels/eyebrows |
| `.type-metric` | 28px | 1.1 | −0.02em | 600 tnum | KPI / stat numbers |
| `.type-clinical` | inherit | - | - | tnum | Any clinical/numeric value |

Rules (from `better-typography`): weight ≥ 400 below 18px; body starts at 14px in
this dense tool (16px is the web default for long-form); headings descend by level;
`tabular-nums` on **any value that changes** (vitals, prices, counts, timers);
inputs render ≥ 16px on mobile to stop iOS zoom; cap long-form measure at 60–75ch;
`text-wrap: balance` on headings, `pretty` on descriptions.

---

## 3. Spacing

Tailwind's default 4px-based scale (`p-1`=4 … `p-6`=24 …). **Grouping rule:**
inter-group gap ≥ 2× intra-group gap (8px within → 16px+ between). Group with
space first, background shape second, separator line last.

Layout margins: `px-4` mobile → `sm:px-6` → `lg:px-8` (matches `HospitalShell`).

---

## 4. Radius

Retuned down from the 24–28px anti-pattern. Concentric rule: **outer = inner + padding.**

| Token / utility | Value | Use |
|-----------------|-------|-----|
| `rounded-control` | 8px | Buttons, inputs, selects |
| `rounded-field` | 8px | Form fields |
| `rounded-surface` | 12px | Cards, panels |
| `rounded-panel` | 16px | Large containers, modals |
| `rounded-full` | pill | Badges, avatars, status pills |

Legacy `--radius-card` retuned to 16/20/12 (was 24/28/20); unused as a utility today.

---

## 5. Elevation

Shadows communicate depth; borders communicate structure/state.

| Utility | Use |
|---------|-----|
| `shadow-e1` | Resting cards, subtle lift |
| `shadow-e2` | Dropdowns, popovers, sticky headers |
| `shadow-e3` | Modals, drawers, command palette |

Prefer a hairline border for structure (dividers, table borders, selected state);
prefer shadow for floating depth. Don't stack both to fake importance.

---

## 6. Motion

| Token | Value | Use |
|-------|-------|-----|
| `--duration-instant` | 80ms | Hover, press feedback |
| `--duration-fast` | 130ms | Toggles, small state changes |
| `--duration-base` | 190ms | Drawers, dropdowns, modals |
| `--duration-slow` | 260ms | Page/section transitions |
| `--ease-standard` | `cubic-bezier(0.2,0,0,1)` | Default UI easing |
| `--ease-out` | `cubic-bezier(0.16,1,0.3,1)` | User-initiated enters |
| `--ease-spring` | `cubic-bezier(0.22,1,0.36,1)` | Playful overshoot (marketing only) |

Full rules in [`motion-guidelines.md`](./motion-guidelines.md). Always honor
`prefers-reduced-motion` (already handled globally in `globals.css`).

---

## 7. Icons

**lucide-react**, single library. Sizes: 13px (dense nav/inline), 15–16px
(standard), 18–20px (headers). Match stroke to Inter weight; align optically, not
geometrically. One icon = one meaning across the product.
