# Aarogya Design Principles

The operating rules behind the [design system](./design-system.md). When a decision
is ambiguous, these - in this priority order - settle it.

## Priority order (a beautiful product that slows clinicians down is a failure)

1. **Usability** - the task completes with the fewest correct steps.
2. **Clinical workflow clarity** - preserve workflow semantics; never redesign a
   clinical flow merely to make it prettier.
3. **Information hierarchy** - the most important thing is the most prominent thing.
4. **Accessibility** - WCAG AA or better, keyboard-complete.
5. **Consistency** - one system, no per-component reinvention.
6. **Performance** - perceived and real.
7. **Responsive behavior** - works desktop → mobile, not shrunk-down desktop.
8. **Visual quality** - premium, not decorative.
9. **Interaction quality** - feedback for every action.
10. **Motion** - last, and only when purposeful.

## What Aarogya communicates

Trust · intelligence · precision · calm · safety · professionalism · modern
healthcare infrastructure · Indian healthcare relevance · enterprise credibility.

## Anti-patterns (rejected, from the tastemaker anti-slop set + clinical reality)

- Generic SaaS aesthetics; indigo→purple gradients; the identical "rounded card +
  soft shadow" everywhere.
- Excessive gradients, glassmorphism, shadows, 3D, particle/gimmicky AI visuals.
- Meaningless or constant ambient motion; animated gradients in workflows.
- Huge rounded cards; visual noise; decorative dashboard chrome.
- Excessive whitespace where information density matters.
- A second accent hue that earns nothing; a color used for two meanings.

## Cross-cutting rules

- **Semantic tokens only.** No arbitrary color, spacing, radius, shadow, or motion
  value without a documented reason. If a role has no token, add the token.
- **One color, one meaning.** Brand = interactive. Status hues = their status. Never
  borrow a token because its value looks right today.
- **One primary action per view**, filled with `brand-strong`; peers neutral.
- **Group with space, not lines.** Inter-group gap ≥ 2× intra-group gap.
- **Shadows for depth, borders for structure.** Don't stack both.
- **Concentric radius.** Outer = inner + padding.
- **Motion by frequency of use.** The more often a clinician sees it, the shorter and
  subtler - often none. Respect `prefers-reduced-motion`.
- **Fix the component, not the instance.** A violating component gets fixed once, not
  cloned into a new variant. Avoid component proliferation.
- **Density is contextual.** Hospital OS is a dense data tool; the public site can breathe.

## The finishing question

Every addition must answer *yes* to at least one: does this improve comprehension,
reduce friction, improve trust, improve consistency, improve safety, improve speed,
improve accessibility, or improve perceived quality? If no - don't add it.

## One platform, five surfaces

Public Aarogya → Patient → Doctor → Hospital OS → Enterprise must read as **surfaces
of one platform**, sharing tokens, type, and iconography - differing only in density
and permitted expressiveness. The marketing site must not look like an unrelated startup.
