# Prismatic liquid-glass workspace — 2026-10-10

## Applied

1. **Prismatic glass material:** replaced both the cream/orange baseline and the first monochrome navy pass with floating translucent panels over visible cyan, electric-blue, violet and coral light sources. Glass now exposes the color behind it instead of behaving like opaque tinted cards.
2. **Capture identity:** a layered capture-frame composition replaces the old window placeholder. Hero CTA performs real region capture. No fake counters or history were added.
3. **Unified SVG family:**37 rendered decorative icons use the same20px grid and1.7px stroke. Icon-only actions retain accessible names.
4. **Typography and density:** strong Korean heading hierarchy, readable local system fonts, shorter home title and word-preserving Korean card copy. All eight primary tools fit the regular first viewport.
5. **Whole workspace consistency:** library, selected/disabled states, alpha checkerboards, translation engine disclosure, settings and shortcut sheet share semantic tokens.
6. **Compact mode:** condensed hero, one-row title/actions, first tool cards, floating bottom glass dock and no horizontal scrolling at420px.
7. **Native window integration:** dark Windows titlebar overlay and a draggable header match the workspace; native window controls remain native.
8. **Keyboard/effect preferences:** visible focus, a native modal dialog that contains keyboard focus, corrected shortcut labels, reduced-motion and reduced-transparency handling, forced-color/unsupported-blur fallbacks.

## Sources and selection

- [frontend-design on Skills.sh](https://skills.sh/anthropics/skills/frontend-design): intentional subject-specific composition, type hierarchy, restraint and screenshot critique.
- [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/main/.claude/skills/ui-ux-pro-max), revision50d8a7de0900119855614541f15a1a616691eb33: an explicit style search returned Glassmorphism (blur10–20px, translucent surfaces, light borders and contrast checks). The broad query returned a minimal landing-page pattern, which was rejected as unsuitable for this utility.
- [DESIGN.md](../DESIGN.md): maintained project contract. External skill guidance was used as a reference; no global skill installation or runtime dependency was added.

## Validation

- TypeScript, repository Biome, production build and26 existing automated tests passed.
- Packaged screenshots cover home/library/translate/settings/shortcut dialog and regular/compact layouts: `.evidence/glass/`. The first prismatic iteration exposed a compact dock overlap and was rejected; the corrected iteration anchors it at the bottom.
- Closed modal scrim is checked as `display:none`; keyboard Tab remains inside the open dialog; all navigation controls stay in the compact viewport; no horizontal overflow.
- Reduced effects check: zero active animations and sidebar blur disabled.
- Static color checks are recorded in `.evidence/glass/contrast.json`; these support the token choices but do not constitute a complete WCAG conformance audit over every gradient pixel.
- The native capture helper was not changed by the visual work. GPU cost of glass in the full editor is not claimed to be zero; no continuous animation, remote fonts or repeated-card blur was added.

## Next improvements, prioritized

1. **Light/dark and transparency preferences:** give users a low-effect solid-panel mode and a light glass palette instead of forcing one appearance.
2. **Immediate post-capture action bar:** copy, pin, OCR and cutout beside the new capture, with keyboard access and a compact progress indicator.
3. **Find and reuse captures:** OCR text search, tags, date filtering and drag-to-other-app export.
4. **Workspaces:** restore groups of pinned references, their position/opacity and selected collection between sessions.
5. **Broader desktop QA:** actual125/150/200% DPI, mixed-monitor transitions, high-contrast settings and real capture interaction. The previously documented execution-session screen-access limitation remains separate from this UI verification.

## Changed files

- `src/renderer/dashboard/dashboard.css`: semantic tokens, glass surfaces, layouts and accessibility modes.
- `src/renderer/dashboard/dashboard.ts`: SVG integration, hero composition, labels and modal focus behavior.
- `src/renderer/dashboard/icons.ts`: dependency-free SVG primitives.
- `src/main/openCapture.ts`: Windows titlebar overlay/color.
- `scripts/verify-design.cjs`: packaged visual/layout checks.
