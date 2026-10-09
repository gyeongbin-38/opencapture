# macOS capture-app benchmark — 2026-10-10

Five macOS screenshot tools were reviewed against official product pages, changelogs and hands-on reviews. OpenCapture is a Windows-first, local-first workspace, so ideas are adapted — not copied — to the existing Electron + dkh-ui architecture.

## App-by-app analysis

### ScreenFloat (Eternal Storms)

- **Core model:** every capture becomes a floating "shot" (Picture-in-Picture for screenshots) plus a persistent **Shots Browser** library. Shots can be floated again any time.
- **Floating shot UX:** hover reveals a translucent toolbar; shots carry title, star rating, tags, notes; adjustable opacity; export in 5 formats with resize/alpha options; drag a shot straight into another app.
- **Data detection:** every shot is analyzed for text, faces, barcodes; right-click quick-redact; QR contents viewable.
- **Editing:** non-destructive annotate/markup/redact; crop/resize with ratio lock; "fold" removes a middle section and stitches the seam; duplicate-before-destructive-edit is offered.
- **Design language:** minimal chrome, controls appear on demand, shot content stays dominant.

### CleanShot X

- **Capture → action flow:** after capture a floating thumbnail ("quick access overlay") offers Copy/Save/Pin/Annotate/Upload immediately — the product is built around *what happens right after* a capture.
- **Pin:** always-on-top, size + opacity, precise nudge with arrow keys, **Lock Mode** (interact with apps under the pin).
- **Capture surface:** crosshair + magnifier for pixel-precise selection, freeze-screen, retake last selection.
- **History:** capture history as a first-class surface; scrolling capture; on-device OCR incl. QR; URL-scheme API for automation.
- **Design language:** compact pill overlays, monochrome icons, actions grouped by destination (copy / save / pin / annotate).

### Shottr

- **Precision instruments:** screen ruler (arrow keys measure, click imprints measurement), pixel-level zoom, smart window snapping, object removal and pixelate, "text mode" redaction that hides text while keeping the background intact.
- **Scrolling capture:** auto-scroll with configurable speed, max-height limit messaging, manual fallback, reverse-direction setting.
- **Design language:** tiny utility (1.2 MB native), speed as a feature — 17 ms capture — minimal UI, keyboard-first.

### Xnapper

- **Beautify pipeline:** capture → auto-detect content → auto-balance on a background with padding, rounded corners and shadow. Background colors are picked from the screenshot itself.
- **Output presets:** social media ratios/sizes (X post, Instagram, YouTube community…), numeric padding/inset/shadow/radius controls (click number to type exact value), saved custom presets.
- **Privacy:** redact sensitive data — emails, credit cards, IPs, API keys — manually or automatically.
- **Design language:** preview-centric canvas, right-side control panel, "zero effort" defaults.

### Snagit (TechSmith)

- **Documentation flow:** Step Capture records clicks into a numbered visual guide; Step tool stamps numbered markers; templates combine images into guides/timelines.
- **Smart Redact:** one click auto-covers sensitive info (contacts, card numbers, faces).
- **Library:** every capture lands in a tray/library with tagging and search.
- **Design language:** task-oriented (capture → annotate → share to docs); heavier but explicit UI.

## Gap analysis vs. OpenCapture today

| Capability | Status in OpenCapture | Source |
|---|---|---|
| Floating pins with opacity/size/translate/focus/blink/dock | ✅ already strong | ding.ts |
| Click-through pins | ✅ exists via dock only | ding.ts `ignore` |
| Scroll capture, OCR, QR, translate, record, number steps | ✅ clip editor | clip_window.ts |
| Capture library with collections, export, combine | ✅ dashboard library | openCapture.ts |
| Post-capture quick actions | ➕ added toast actions | CleanShot |
| Pin arrow-key nudge + toolbar click-through + OCR copy | ➕ added | CleanShot/ScreenFloat |
| Library search + favorites + rename + duplicate | ➕ added | ScreenFloat/Snagit |
| Drag capture out to other apps | ➕ added | ScreenFloat/CleanShot |
| Auto redaction of sensitive text | ➕ added to clip editor | Snagit/Xnapper/Shottr |
| Beautify (padding/radius/shadow/auto background/ratios) | ➕ added dialog | Xnapper |
| Non-destructive annotate (editable objects) | ✅ fabric objects already editable | — |
| Step recorder (click → auto guide) | ⏸ deferred — needs global input hooks | Snagit |
| Capture "fold"/stitch middle removal | ⏸ deferred | ScreenFloat |
| Screenshot templates beyond v/h combine | ⏸ deferred | Snagit |
| Freeze-frame during selection, ruler imprint | ⏸ deferred (size display exists) | CleanShot/Shottr |

## What was adopted this round

1. **Library search & favorites** — filter by name, star captures, favorites-only view (ScreenFloat shots browser, Snagit library).
2. **Rename & duplicate** — item menu actions; duplicate preserves the original before destructive work (ScreenFloat).
3. **Drag-out** — drag a library card straight into another app (ScreenFloat/CleanShot).
4. **Post-capture toast actions** — copy/pin/open the just-arrived capture (CleanShot quick access overlay, adapted to a toast so it never steals pointer focus).
5. **Pin polish** — arrow-key nudge (1 px, Shift 10 px), per-pin click-through toggle in the hover toolbar, OCR "copy text" button (CleanShot lock mode + ScreenFloat data detection).
6. **Smart redact** — clip-editor button finds emails, card numbers, phone numbers, IPs, secrets and IDs via local OCR and covers each line with its detected background color (Snagit Smart Redact + Shottr text-mode + Xnapper auto-redact).
7. **Beautify dialog** — auto-balanced padding, corner radius, shadow, image-derived backgrounds and output ratios; result saves back to the collection as a new item (Xnapper).

All new processing stays local; no new runtime dependencies; design tokens follow `DESIGN.md` (glass surfaces, spectrum accents, 1.7 px icon family).
