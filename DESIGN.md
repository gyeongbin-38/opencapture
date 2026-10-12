# Design

## Source of truth
Active — 2026-10-11. OpenCapture desktop workspace, capture overlay and reference comparison. Evidence includes the existing dashboard styles, capture overlay code and the user's screenshot showing oversized pale controls. This file owns the visual contract; the latest black, compact direction supersedes the earlier colorful glass design.

References consulted: [frontend-design](https://skills.sh/anthropics/skills/frontend-design), [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/main/.claude/skills/ui-ux-pro-max), local design/visual-verdict skills. UI UX Pro Max revision `50d8a7de0900119855614541f15a1a616691eb33`; direct style query matched Glassmorphism. Its broad design-system query returned a minimal landing-page pattern, which does not fit this desktop utility; only the explicitly matched glass guidance and relevant accessibility/performance guidance are adopted.

## Brand
Quiet, precise and immediate. Neutral black surfaces, restrained white outline icons, readable controls and original image colors. Trust comes from clear source/result distinction, real execution feedback and preservation of originals. Avoid colored accents, emoji icons, oversized pale panels, paragraphs of instructions and perpetual animation.

## Product goals
Make capture, size adjustment, copying and comparison usable at the point of work. Preserve all working actions, expose primary actions below the selection and put the remainder behind a button or right-click. Support multiple selected references without silently overwriting the clipboard. No new dependency.

## Personas and jobs
Korean-speaking desktop users collecting references, translating screenshots and reusing multiple captures. Work in full workspace or narrow always-accessible shelf; primarily pointer and keyboard users.

## Information architecture
Four stable destinations: home, library, translate, settings. Capture overlay: compact dimensions above the selection, eight resize handles, a small rectangular action bar below it. Right-click on the image opens a radial menu at the pointer; essential actions form one ring, additional actions are paginated. Library selection exposes copying and a comparison dialog; secondary controls stay collapsed until relevant.

## Design principles
1. Hierarchy comes from size, spacing, borders and restrained elevation.
2. Show a few immediate actions; reveal secondary tools on demand.
3. A rectangular bar anchors actions below the selected image, while right-click keeps tools near the user's hand.
4. Image thumbnails retain natural color and visible alpha checkerboards.
5. Keyboard focus and compact navigation remain visible.

## Visual language
- Background `#0c0c0e`, surface `#18181c`, white text `#f4f4f5`, secondary text `#a1a1aa`, borders white at 12–18% opacity. Image content keeps its natural colors.
- Typography: local Segoe UI Variable/Segoe UI/Malgun Gothic. UI 12–14px, dimensions 12px with tabular figures. No remote fonts.
- Spacing: 4/8px rhythm. Capture controls start at 32px and allow 28–44px adjustment. Action bar radius 12px, button radius 7px; a thin edge and soft black shadow give depth.
- Optional 16px blur on small floating controls with opaque fallbacks. Hover 120ms. Radial buttons travel from the center in 160–220ms with short stagger. No continuous motion; reduced-motion disables travel.
- Local outline SVGs, 20px viewbox, 1.6px rounded strokes. No emoji as control labels.

## Components
Dashboard tokens in `src/renderer/dashboard/dashboard.css`; capture tokens in `src/renderer/css/clip.css`. Existing dkh-ui and action handlers remain. Components: compact action bar, expandable tool popover, animated radial menu, dimension fields, ratio lock, selection resize handles, image multiselect and reference comparison. The color magnifier appears only during selection or explicit color picking.

## Accessibility
Normal readable text target4.5:1 on effective composed surfaces; controls/focus3:1. Visible focus ring, no color-only state, icon buttons labelled. Preserve semantic button/input controls. Honor prefers-reduced-motion, prefers-reduced-transparency and forced-colors. Large transparent areas receive opaque fallback. No forced animation or hover-only critical actions.

## Responsive behavior
Wide1180×810; medium~850px; compact420×560 (content~407×524) and min360px. Reduce art and large hero in compact view, retain primary action, first library thumbnails and bottom navigation. No horizontal scrolling, modal bounds within viewport, Windows title controls reserve rightmost space.

## Interaction states
Empty library provides an import action. Loading and errors remain real. Selected cards use border and checkbox. Comparison accepts image references and reports unsupported items. Clipboard labels explicitly distinguish a composite image from independent files. Escape closes the current tool surface before closing capture; right-click never discards the selection.

## Content voice
Concise Korean action labels. No marketing metrics or new technical terminology. Preserve context around local processing vs online provider transmission.

## Implementation constraints
Electron + dkh-ui + plain CSS/TypeScript. No npm/icon/animation dependencies or CDN fonts. The native launcher dispatches into the shared Electron capture editor; native and Electron hotkey ownership must never overlap. Main workspace may use a Windows native titlebar overlay with a draggable header; OS buttons remain native. Validate builds, existing tests, packaged screenshots of all four destinations and wide/compact layouts, overflow, focus and reduced effects. Record visual verdict before subsequent style edits.

## Open questions
No blocking design questions. This iteration implements the requested compact black controls and preserves the existing feature set.

## Browser feature lab

The local browser workbench is now the active feature-development surface. A compact rail links editor, capture, library, media and feature checks. The shared editor and processing contracts are reused for eventual desktop integration. Native OS capabilities are labelled app-only; browser permission flows are never simulated as completed actions.

Controls have at least40px targets, 8px control gaps and16px group gaps. Numeric fields have visible labels. Toolbars size from their own measured content, independent of image size; overflow tools remain reachable behind More. Floating browser references and position locking are separate actions. Properties/layers/options stay closed until requested.

## Temporary capture workspace and feedback

Temporary captures remain separate from the permanent library and can be reopened with their editable annotations. A small, resizable black shelf shows recent previews without taking keyboard focus. Multiple source files and a composed bitmap have distinct copy actions.

Capture feedback follows the actual result: a 150ms selection settle, 180ms radial reveal, clear gesture target, and a short thumbnail arrival only after a committed save. No repeated save animation on annotation autosaves. Sound is optional and disabled by default; reduced motion skips travel and scaling. Errors retain the capture and offer retry.

Toolbar and radial favorites are configurable. The first view exposes essential controls only; presets, layouts, OCR review and comparison details appear when requested. Comparison notes remain anchored in normalized image coordinates and are rendered into exports.

## Capture board extension

The dashboard home exposes one primary capture button, three recent captures and continue-work. A board destination provides tabs and several captured images with free placement, group/layout/focus, notes and shape annotations. Tool drawers, layers, styles and export actions remain collapsed until selected. The existing capture overlay and floating pins keep their compact controls.

Long left press on image content waits650ms, cancels at8px movement or release, and reveals a quiet progress ring. Drawing/text/resize controls never trigger cutout. Background removal prepares a new transparent asset; originals remain undoable. Board geometry and asset references persist separately with revision checks. DOM text uses textContent; working previews1024 edge and twelve decoded visible images.
