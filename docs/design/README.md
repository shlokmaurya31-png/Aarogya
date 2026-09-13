# Aarogya Design

Aarogya's own design language, synthesized from seven external design-skill libraries
(studied as research, not copied). Read in this order:

1. [design-research.md](./design-research.md) - what was studied, adopted, rejected
2. [design-principles.md](./design-principles.md) - the operating rules & priority order
3. [design-system.md](./design-system.md) - tokens (source of truth: `src/app/globals.css`)
4. [navigation-model.md](./navigation-model.md) - role-based IA
5. [component-inventory.md](./component-inventory.md) - current vs target components
6. [responsive-strategy.md](./responsive-strategy.md) - desktop → mobile behavior
7. [motion-guidelines.md](./motion-guidelines.md) - purposeful motion only
8. [ux-audit.md](./ux-audit.md) - findings (code-level; rendered checks flagged)
9. [design-debt.md](./design-debt.md) - prioritized, actionable inventory

**Status:** foundations implemented (semantic token layer in `globals.css`, build
verified green). Everything is additive - legacy utilities still resolve, so the debt
can be paid down progressively without regressions.
