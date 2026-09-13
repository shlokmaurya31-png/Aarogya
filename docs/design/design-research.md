# Aarogya Design Research

Synthesis of seven external design-skill libraries into inputs for **one** Aarogya
design language. The libraries are references for *principles and techniques* - not
templates to copy. Aarogya is the output; they are the inputs.

## Repositories studied

| Repo | Primary purpose | Strongest ideas extracted |
|------|-----------------|---------------------------|
| **jakubkrehel/skills** (`better-colors`, `better-typography`, `better-layout`, `better-ui`, `better-accessibility`) | Rigorous, review-grade design-system rules | Primitives-by-hue / semantics-by-role token seam; "one color, one meaning"; type scale with semantic names; line-height by role; concentric radius (outer = inner + padding); shadows for elevation, borders for structure; group with space (2× rule); measure contrast, never estimate |
| **emilkowalski/skills** (`animation-vocabulary`, `apple-design`, `find/improve/review-animations`) | Motion craft | Frequency-of-use → shorter & subtler; purposeful motion only; `ease-out` default for user-initiated; interruptible CSS transitions; exact values not ranges; respect `prefers-reduced-motion`; stagger ~100ms for infrequent staged entrances |
| **codeswithroh/tastemaker** | Anti-"AI-slop" taste engine | Name and avoid slop tells (indigo→purple gradients, identical rounded card + soft shadow, hand-rolled charts/bento); classify each screen (marketing / app-shell / form / data-view / settings / empty) to control density & motion; craft = many small compounding choices; delete motion where daily use makes it annoying |
| **Owl-Listener/designer-skills** (`visual-critique`, `design-systems`, `ui-design`, `interaction-design`) | Structured critique + IA | Seven critique dimensions (hierarchy, brand, composition, typography, colour, affordance, density) with severity-ranked fix lists; Hick's/Fitts' framing for IA |
| **ai-design-skills** (`landing-page-design`) | Marketing narrative | Public-site narrative structure - used only for the public Aarogya surface (Phase 6) |
| **garden-skills** (`web-design-engineer`, `beautiful-article`) | Implementation craft | Editorial rhythm and web-engineering polish for the public site and long-form content |
| **MengTo/Skills** (`web-design`) | Practical web design workflow | General layout/spacing sanity; least novel given the above; used lightly |

## Strongest ideas adopted (the synthesis)

1. **Two-tier token seam** (jakub): primitives named by hue, semantics named by role;
   components reference *only* the semantic tier. This is the backbone of the Aarogya
   system and what makes light/dark and future re-theming safe.
2. **One color, one meaning** (jakub): resolved Aarogya's brand ambiguity - see below.
3. **Restraint over decoration** (tastemaker + emil + jakub, unanimous): fewer fonts,
   fewer sizes, controlled radius, elevation not ornament, motion only when purposeful.
4. **Screen classification drives density & motion** (tastemaker): Hospital OS = data-view
   density with near-zero decorative motion; public site = marketing narrative where scroll
   can teach.
5. **Concentric radius + optical alignment + shadows-for-depth/borders-for-structure**
   (jakub better-ui): the compounding small details that read as "premium."
6. **Motion by frequency of use** (emil): the more often a clinician sees an animation, the
   shorter and subtler it must be - often zero.

## Ideas rejected / rejected-for-Aarogya

- **Decorative landing-page effects everywhere** (implied by several marketing-leaning skills)
  - rejected for clinical surfaces; safety and speed outrank spectacle.
- **oklch migration of the whole palette** (jakub's ideal for a *new* system) - Aarogya already
  ships a coherent hex token set used by 100+ files. jakub's own rule "match the project's
  color system" wins: we extend in hex, not scatter oklch through it.
- **Heavy glassmorphism / film-grain noise / holo-grid** (present in current landing) - kept
  *only* on the public marketing hero, removed from any app/clinical surface.
- **Big rounded cards (24–28px)** - an explicit anti-pattern; retuned to 12–16px.
- **New accent hues per component** - forbidden by "one color, one meaning."
- **Copying any external repo's visual identity wholesale** - Aarogya keeps its own identity.

## Conflicts discovered & how they were resolved

| Conflict | Resolution |
|----------|-----------|
| Marketing skills favor expressive motion; emil/jakub favor restraint | Screen-classification: expressive allowed on public site, restrained in-app |
| jakub prefers oklch; project is hex | Keep hex (jakub's own "match the project" rule) |
| Current app uses **cyan** in the shell/theme but **emerald** as `StatusPill` default & selection - two brand candidates | **Teal/cyan = brand** (matches `manifest` themeColor `#0e7490`, 116 files already use cyan). **Emerald = success only.** One color, one meaning. |
| tastemaker wants reference-grounded palettes; healthcare needs conventional status colors | Brand is grounded/distinct; status colors stay conventional (green/amber/red) for safety recognizability |

See [`design-system.md`](./design-system.md) for the resulting tokens and
[`design-principles.md`](./design-principles.md) for the operating rules.
