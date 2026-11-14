# Design

## Source of truth
Active — 2026-10-29. OpenCapture desktop workspace, conversion, capture, pins, recording and detailed tools. Evidence includes the current code and wide/compact screenshots in `.evidence/product-minimal/`. This file owns the visual contract: a compact neutral dark desktop utility with immediate capture and details revealed on demand. macOS and Mac App Store are separate distribution targets; current Windows evidence does not establish Mac runtime support.

The user's primary product-design and workflow reference is [Tracer](https://nmuxlab.com/kr/tracer/). Its official capture/floating posters were inspected and retained in `.evidence/benchmark-20261029/`; they show a compact translucent neutral toolbar, local action feedback, a precise magnifier and image-first interaction. Treat these as workflow and visual evidence, separate from its marketing-page layout. Capture → markup/OCR/translate → copy/save/float should remain one short flow. Floating focus, click-through and blink comparison are primary reference tasks. Benchmark features from macshot, CleanShot X, Shottr, Xnip, ScreenFloat, Snapzy, Xnapper, Snagit and Tangerine support this contract rather than introducing competing visual systems. Native behavior and full parity remain separately verifiable work.

References consulted: [frontend-design](https://skills.sh/anthropics/skills/frontend-design), [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/main/.claude/skills/ui-ux-pro-max), local design/visual-verdict skills. UI UX Pro Max revision `50d8a7de0900119855614541f15a1a616691eb33`; direct style query matched Glassmorphism. Its broad design-system query returned a minimal landing-page pattern, which does not fit this desktop utility; only the explicitly matched glass guidance and relevant accessibility/performance guidance are adopted.

## Brand
Quiet, precise and immediate. Neutral black surfaces, restrained white outline icons, readable controls and original image colors. Trust comes from clear source/result distinction, real execution feedback and preservation of originals. Avoid colored accents, emoji icons, oversized pale panels, paragraphs of instructions and perpetual animation.

## Product goals
Make capture, size adjustment, copying and comparison usable at the point of work. A fresh profile can capture immediately without dismissing a tutorial. Preserve all working actions, expose primary actions below the selection and put the remainder behind a button or right-click. Load AI runtimes and capture renderers only when needed unless the user explicitly chooses preloading. Support multiple selected references without silently overwriting the clipboard. No new dependency.

## Personas and jobs
Korean-first desktop users and people using the available interface catalogs, collecting references, translating screenshots and reusing multiple captures. Work in full workspace or narrow always-accessible shelf; primarily pointer and keyboard users.

## Information architecture
Five stable destinations: home, library, board, translate, settings. Capture overlay: compact dimensions above the selection, eight resize handles, a small rectangular action bar below it. Right-click on the image opens a radial menu at the pointer; essential actions form one ring, additional actions are paginated. Conversion uses a compact rectangular preview dialog. Library selection exposes copying and comparison; secondary controls stay collapsed until relevant.

## Design principles
1. Hierarchy comes from size, spacing, borders and restrained elevation.
2. Show a few immediate actions; reveal secondary tools on demand.
3. A rectangular bar anchors actions below the selected image, while right-click keeps tools near the user's hand.
4. Image thumbnails retain natural color and visible alpha checkerboards.
5. Keyboard focus and compact navigation remain visible.
6. Use one active indicator and one functional boundary per group. Prefer an inline row or a divider to nested rounded panels; reserve elevation for floating windows and dialogs. Secondary filters belong in the existing disclosure, with active filtering still visible.

## Visual language
- Background `#0c0c0e`, surface `#18181c`, white text `#f4f4f5`, secondary text `#a1a1aa`, borders white at 12–18% opacity. Image content keeps its natural colors.
- Typography: local system fonts, Segoe UI on Windows and the system UI font on macOS, with Korean fallbacks. UI 12–14px, dimensions 12px with tabular figures. No remote fonts.
- Spacing: 4/8px rhythm. Capture controls start at 32px and allow 28–44px adjustment. Capture bars, dimension fields and the pixel magnifier use square corners, a single thin edge and restrained elevation. Round shapes are reserved for the radial interaction and functional swatches.
- Optional 16px blur on small floating controls with opaque fallbacks. Hover 120ms. Radial buttons travel from the center in 160–220ms with short stagger. No continuous motion; reduced-motion disables travel.
- Local outline SVGs, 20px viewbox, 1.6px rounded strokes. No emoji as control labels.

## Components

The 2026-10-29 reference audit is recorded in `.omx/research/design-20261029/design-audit.md`, with hashed official images in `design-assets.json`. Tracer remains the primary workflow reference. Its floating poster shows capture selection, not a completed pin window; unobserved native screens remain unknown. Xnip's local options, macshot's content-first editor, and ScreenFloat's separated browser controls inform hierarchy rather than brand or asset copying.

File tools collapse a loaded source list into its selected/total count. The count is an explicit expand button; individual file checkboxes remain available on demand. The operation picker uses one body scroll. Selecting a recipe replaces the picker with named options and an explicit change-operation button. Existing library folders appear as optional destinations alongside the native folder picker, without changing the active capture folder. Source rows and repeated drag text yield space to the task; the file shelf keeps accessible 40px icon handles and its native drag implementation.
Dashboard tokens in `src/renderer/dashboard/dashboard.css`; capture tokens in `src/renderer/css/clip.css`. Existing dkh-ui and action handlers remain. Components: compact action bar, expandable tool popover, animated radial menu, dimension fields, ratio lock, selection resize handles, image multiselect and reference comparison. The color magnifier appears only during selection or explicit color picking.

## Accessibility
Normal readable text target4.5:1 on effective composed surfaces; controls/focus3:1. Visible focus ring, no color-only state, icon buttons labelled. Preserve semantic button/input controls. Honor prefers-reduced-motion, prefers-reduced-transparency and forced-colors. Large transparent areas receive opaque fallback. No forced animation or hover-only critical actions.

## Responsive behavior
Wide1180×810; medium~850px; compact420×560 (content~407×524) and min360px. Reduce art and large hero in compact view, retain primary action, first library thumbnails and bottom navigation. No horizontal scrolling, modal bounds within viewport, Windows title controls reserve rightmost space. Compact board tools and canvas end above fixed navigation; verify pointer hit targets as well as bounds.

## Interaction states
Empty library provides an import action. Loading and errors remain real. Selected cards use border and checkbox. Comparison accepts image references and reports unsupported items. Clipboard labels explicitly distinguish a composite image from independent files. Escape closes the current tool surface before closing capture; right-click never discards the selection.

## Content voice
Concise action labels in the selected interface language. Korean is the default; language choice is a direct settings row. Show pending language changes explicitly and apply the startup language consistently across windows without interrupting active work. No slogans, marketing metrics, repeated title/description stacks or new technical terminology. Preserve context around local processing vs online provider transmission. Lab tools retain their existing English compatibility dictionary; other catalog gaps retain their existing source fallback. Do not imply complete translation coverage.

## Implementation constraints
Electron + dkh-ui + plain CSS/TypeScript. No npm/icon/animation dependencies or CDN fonts. The native launcher dispatches into the shared Electron capture editor; native and Electron hotkey ownership must never overlap. Main workspace may use a Windows native titlebar overlay with a draggable header; OS buttons remain native. Validate builds, existing tests, screenshots of all five destinations and the packaged runtime, wide/compact layouts, overflow, focus and reduced effects. Record visual verdict before subsequent style edits.

## Open questions
- [ ] Validate capture/recording permissions, native modules and file persistence on real Apple Silicon and Intel Macs. Owner: platform validation. Impact: Mac runtime and App Store readiness remain unverified until this evidence exists.
- [ ] Complete security-scoped bookmark persistence and sandbox-compatible alternatives for global input features before MAS submission. Owner: platform implementation. Impact: a nominal MAS package configuration must not be reported as store-ready.
- [ ] Provide a lightweight macOS menu-bar entry with the same on-demand workspace behavior as the Windows tray helper. Owner: platform implementation. Impact: Electron idle measurements do not establish a lightweight native Mac resident mode.

## Conversion and desktop action completion — 2026-10-17

Conversion follows format selection, no-write source/result preview, then explicit Convert. The compact rectangular dialog has one primary action, visible dimensions and honest export size; labeled Options and presets start collapsed. Results remain available per file with separate export/registration outcomes and targeted retries. Native dragging prepares once, then uses a fresh drag handle and reports dispatch only. Opening, previewing and changing options never create export files. Cancellation retains committed output, dismissal settles callers once, shortcuts respect text editing and focus restores to the opener.

Home presents capture, recent work and navigation without oversized slogans, repeated eyebrow labels or nested decorative cards. Settings, comparison, board and capture details retain all existing actions behind clearly named disclosures where appropriate. Prefer spacing and one subtle divider to repeated panels. Main copy is14px, metadata may be12px, headings20–24px. Compact navigation targets are at least40px; do not achieve minimalism by shrinking labels, hit targets or hiding critical status. Dialog bodies scroll vertically within the viewport.

Text cards disclose shortened previews and expose retained original text in a scrollable, selectable viewer with Copy. Session/workspace restoration preserves card semantics. QR failures remain visibly failures with text/copy/retry actions. Recording exposes real ready, recording, paused, processing, saved, cancelled and error states; advanced setup and logs remain collapsed and reachable.

Desktop radial selection uses the center that is actually visible after screen-edge adjustment. Repeat capture runs sequentially, reports failures and always clears progress. Text pins use the existing foreground/background theme tokens; QR cards use black on white in both themes.

## General file tools — 2026-10-18

The library exposes a single File tools entry. Existing image conversion remains immediate; arbitrary and mixed files open a compact rectangular dialog with Convert, Tools and Actions. Sources remain individually selectable; every recipe states eligible and incompatible counts. Advanced parameters appear after recipe selection. File and folder pickers are separate on Windows/Linux. Local jobs run sequentially, report per-file output/error/cancellation and retain committed results. Originals are preserved except an explicitly selected native Move action. Destination collisions never authorize overwriting or recursive cleanup of other files. Unsupported formats and platform-specific actions must disclose their actual capability.

Alt+1/2/3 switch sections within the dialog; arrow keys and Enter operate the focused recipe, Escape cancels active work before closing and focus returns to the opener. Standalone Shift/Control/Command retain ordinary selection, copy and reverse-tab behavior. No new navigation destination, global hook or resident process. Media encoders are probed on first use. PDF parsing/rendering runs only on demand in a separate sandboxed renderer; all fonts, CMaps and WASM assets stay local. Office uses a separately installed LibreOffice with isolated profiles and actual process termination checks; its permissions remain those of the external engine. The Tangerine public demo and REA analysis are behavioral research references; its code, assets, branding and visual identity are not product dependencies. Finder-wide drag integration, Pages output, editable PDF-to-Office reconstruction and real macOS execution remain explicit gaps.

Float opens a small, unfocused always-on-top file shelf only when requested. Mixed files/folders use opaque IDs and native icons, selection, awaited copy/path actions and acknowledged native drag dispatch. A fixed footer remains reachable at240×220, while rows scroll. Creation cancellation prevents a late window; after creation the shelf is independent of the parent dialog. Closing it releases IPC, source references and copy operations. Existing full image pins retain their separate capture workflow.

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
