# Design

## Source of truth
Active — 2026-10-10. OpenCapture desktop workspace: home, library, translation, settings, shortcut dialog and compact shelf. Existing screenshots `.evidence/library-wide.png` and `library-compact.png` were inspected. The previous cream/orange theme was explicitly rejected by the user. This file owns the visual contract.

References consulted: [frontend-design](https://skills.sh/anthropics/skills/frontend-design), [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/main/.claude/skills/ui-ux-pro-max), local design/visual-verdict skills. UI UX Pro Max revision `50d8a7de0900119855614541f15a1a616691eb33`; direct style query matched Glassmorphism. Its broad design-system query returned a minimal landing-page pattern, which does not fit this desktop utility; only the explicitly matched glass guidance and relevant accessibility/performance guidance are adopted.

## Brand
Prismatic liquid glass: a dark obsidian desktop with cyan, electric blue, violet and coral light visibly passing through floating translucent layers. A creative instrument that feels cut from optical glass rather than painted with a dark theme. Trust comes from clear source/result distinction, visible offline/online engine state and original preservation. Avoid monochrome navy slabs, cream/terracotta monotone, emoji icons, decorative counters, fake history and perpetual animation.

## Product goals
Make capture actions immediately identifiable; make stored images the focus of the library. Improve perceived quality without increasing the native helper's idle footprint. Preserve all working capture, workflow and translation actions. No new feature or dependency is required by this restyle.

## Personas and jobs
Korean-speaking desktop users collecting references, translating screenshots and reusing multiple captures. Work in full workspace or narrow always-accessible shelf; primarily pointer and keyboard users.

## Information architecture
Four stable destinations: home, library, translate, settings. Sidebar on wide screens; bottom icon navigation in compact mode. Home has a prominent capture action and categorized tools; library prioritizes selection/preview; translation clearly names the active provider.

## Design principles
1. Material depth comes from translucent floating layers, chromatic edges, refraction and static light sources visible behind them—not from opaque colored panels.
2. Color identifies tool categories; text/icon labels also communicate meaning.
3. One hero composition suggests captured fragments and framing; surrounding controls stay disciplined.
4. Image thumbnails retain natural color and visible alpha checkerboards.
5. Keyboard focus and compact navigation remain visible.

## Visual language
- Obsidian `#080A17`; glass surface `rgba(20,28,54,.48)`; frost text `#F5FBFF`; muted text `#B9C7DB`.
- Spectrum: cyan `#64F1E2`, electric blue `#79A7FF`, coral `#FF9BB8`, amber `#FFBF83`, violet `#C1A9FF`. Colored light exists behind glass and at meaningful tool edges, rather than tinting every panel solidly.
- Typography: locally available Segoe UI Variable Text/Segoe UI and Malgun Gothic; no remote font fetches. UI body14px, metadata12px, title27px, hero32px (24px compact). No serif fallthrough intended.
- Spacing: 4/8px rhythm, 24/32px section gutters. Panel radii20px, controls10px, icon tiles12px. Subtle bright top edge and tinted shadow indicate glass thickness.
- Blur: 28–34px on the floating sidebar/hero/dialog and14px on visible action cards; repeated thumbnail cards use a lighter12px material. Four static blurred spectral lights sit behind the workspace. Hover/focus transitions120–180ms; no continuous animation.
- Consistent bespoke outline SVG family, 20px viewbox and1.7px stroke; all decorative SVGs aria-hidden.

## Components
Shared tokens in `src/renderer/dashboard/dashboard.css`. Existing dkh-ui DOM and handlers remain. New code-native icons in `icons.ts`; hero uses layered capture frames. Primary/secondary/ghost buttons, tool cards, multiselect image cards, workflow toggles, engine panel, state badges and shortcut dialog share tokens.

## Accessibility
Normal readable text target4.5:1 on effective composed surfaces; controls/focus3:1. Visible focus ring, no color-only state, icon buttons labelled. Preserve semantic button/input controls. Honor prefers-reduced-motion, prefers-reduced-transparency and forced-colors. Large transparent areas receive opaque fallback. No forced animation or hover-only critical actions.

## Responsive behavior
Wide1180×810; medium~850px; compact420×560 (content~407×524) and min360px. Reduce art and large hero in compact view, retain primary action, first library thumbnails and bottom navigation. No horizontal scrolling, modal bounds within viewport, Windows title controls reserve rightmost space.

## Interaction states
Empty library provides an import action. Loading/translation/queue states remain real. Error text readable on high-opacity panels; toast above bottom navigation. Disabled bulk actions visibly disabled. Selected cards use border+checkbox; API provider disclosure remains accurate.

## Content voice
Concise Korean action labels. No marketing metrics or new technical terminology. Preserve context around local processing vs online provider transmission.

## Implementation constraints
Electron + dkh-ui + plain CSS/TypeScript. No npm/icon/animation dependencies or CDN fonts. Native QuickCapture helper untouched. Main workspace may use a Windows native titlebar overlay with a draggable header; OS buttons remain native. Validate builds, existing tests, packaged screenshots of all four destinations and wide/compact layouts, overflow, focus and reduced effects. Record visual verdict before subsequent style edits.

## Open questions
- [ ] User preference for a future light/dark switch remains optional; this iteration implements the requested colorful glass direction as one coherent dark workspace.
