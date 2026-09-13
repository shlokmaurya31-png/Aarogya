# Aarogya Motion Guidelines

Motion communicates **state or hierarchy**, never decorates. In clinical surfaces the
default is *no* motion; earn every animation.

## Governing rule: frequency of use
The more often a user sees an animation, the shorter and subtler it must be - often
zero. A once-per-session drawer can afford 190ms; a row a nurse re-renders 200×/shift
should not animate at all.

## Tokens (see [`design-system.md`](./design-system.md) §6)
Durations `--duration-instant/fast/base/slow` (80/130/190/260ms).
Eases `--ease-standard` `cubic-bezier(0.2,0,0,1)` (default UI), `--ease-out` (enters),
`--ease-spring` (marketing overshoot only). Use exact values, not approximations.

## By interaction
| Interaction | Duration | Ease | Notes |
|-------------|----------|------|-------|
| Hover / press feedback | 80ms | standard | Press = subtle `scale(0.98)` |
| Toggle / checkbox / small state | 130ms | standard | |
| Dropdown / popover / menu | 190ms | out | Origin-aware where cheap |
| Drawer / modal enter | 190ms | out | Exit softer & shorter than enter |
| Drawer / modal exit | 130ms | out | Small `translateY`, not full height |
| Page / section transition | 260ms | standard | Sparingly; never in a tight workflow |
| Icon state change | 130ms | out | `opacity 0→1`, `scale 0.25→1`, `blur 4px→0` |
| Staged entrance (infrequent) | ~100ms stagger | out | Only where sequence = hierarchy |

## Techniques (from the animation vocabulary)
- **Interruptible**: use CSS transitions for interactive state so they can redirect
  mid-flight; reserve `@keyframes` for one-shot staged sequences.
- **Skeleton / shimmer** for loading; **number ticker + tabular-nums** for changing
  metrics; **layout animation** so moved items animate rather than snap.
- **Compositing only**: animate `transform` and `opacity`; never `width/height/top/left`
  (layout thrashing / jank).

## Where motion is banned
Dense worklists/tables, clinical documentation, high-frequency status updates,
anything safety-critical. No ambient float/pulse/animated-gradient/particles in app or
clinical surfaces. Expressive motion (`ease-spring`, scroll reveal, parallax) is
allowed **only** on the public marketing site.

## Accessibility
`prefers-reduced-motion: reduce` is already handled globally in `globals.css`
(durations collapse to ~0). Never convey state through motion alone - pair with color,
text, or icon.
