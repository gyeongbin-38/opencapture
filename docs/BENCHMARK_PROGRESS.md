# Benchmark integration progress — 2026-10-29

## Capture reliability pass — 2026-10-30

Fixed selection clipping/wrapping and edge movement, interrupted region/handle drags, stale live translation, scrolling-session reuse/late work, quick-capture request races and missing destinations, recorder display/window/shortcut/extension handling, and external-open export/path handling. Windows fallback now checks the input-desktop boundary before GDI capture and reports inactive desktop access instead of accepting a black result; legitimate accessible black frames remain valid.

Verification:370 tests passed,1 existing skipped across49 files;21 capture/recorder backend cases; actual imported-image drag/resize cancellation, Save-panel reuse, annotation pixels and draft restoration passed. Two native requests correctly terminal-failed with one notification each, no visible overlay and no empty draft. The automation thread is on `Default` while the input desktop is `Screen-saver`, so normal fresh desktop pixels remain unverified. A fresh unsigned Windows package passed77 compiled/catalog/worker hash comparisons, packaged dispatch/error handling, local translation and isolation. The previous live draft revision5, source pixels and real configuration hash were preserved while upgrading the running app. Evidence: `.evidence/capture-next-20261030/verification.json`; changed files, simplifications and remaining limits: `.omx/research/capture-next-20261030/report.md`.

General sticky-header/repeated-content matching, physical extra-monitor validation, real macOS execution, native permission persistence and App Store signing remain separate work. No unsupported matcher confidence threshold, new product dependency or visual system was introduced.

## Minimal design and interface language pass

The design/anti-slop pass removes repeated home copy, duplicate selection decoration and count-pill framing, groups secondary library filters in the existing disclosure, fixes the851px toolbar overflow and compact toast clipping, and keeps functional focus/error boundaries. Settings now expose the existing nine language catalogs directly, with a configured-vs-active startup snapshot and a pending-only note. Changing language writes only `语言.语言` and never reloads/relaunches active work. Counts, dates and command matching use the selected language where catalogued.

Verification:291 tests passed,1 skipped across41 files;28 primary UI checks; six language launches,30 Arabic/French/Russian page-width checks and3 Window capture checks passed. The real profile was preserved. A fresh unsigned Windows package passed runtime checks and77 compiled/catalog hash comparisons. Final evidence: `.evidence/minimal-language-20261029/verification.json`; cleanup details: `.omx/research/minimal-language-20261029/cleanup-report.md`. Existing catalog gaps and native Mac validation remain explicit limits.

## Latest product/design pass

- Explicit Window capture now selects actual system window boundaries independently of saved recognition settings. Windows physical window coordinates are normalized to Electron DIP before mapping to the captured canvas. Actual125% Electron capture, native-window hover/click and return to ordinary region capture passed with the real profile preserved. See `.evidence/window-capture/qa.json`.
- File tools reuse registered library folders as optional export/copy/move destinations, re-resolved in the main process by opaque ID. Existing cancellation and no-overwrite jobs remain shared; active capture folders are not changed. MAS does not reuse unpersisted folder permissions and explicitly disables these entries.
- The compact dialog collapses loaded sources behind the selected/total count, keeps individual selection on demand, names the selected tool above its options, and uses a compact destination footer. The floating file shelf uses accessible40px icon drag handles. No product dependencies were added.
- The fresh official screenshot audit covers22 assets from the ten-product reference set, including reused Tracer posters. Seventeen show app UI. Shottr remains notification-only; Xnapper shows v1.14.1 and Snagit uses2024 help screenshots. These are partial visual references, not ten native app executions. See `.omx/research/design-20261029/design-audit.md`.
- REA6.8.0 inspected the actual ScreenFloat2.3.11 trial ZIP:1,119 static occurrences and882 nodes, no target execution. Linux cannot provide REA's Mac plist/layout analysis. Full retained Evidence, SHA-256, capability failures and isolated-project cleanup are documented in `.omx/research/design-20261029/rea-report.md` and `.evidence/design-20261029/rea/`.

Fresh checks:288 tests passed,1 opt-in skipped across40 files;28 production File tools UI/export checks and3 production Window capture checks passed. Format, lint, full TypeScript, web checks,7 MAS source guards and7 capture action guards passed. The media test fixtures were reduced and long-running integration deadlines made explicit after measured load-related timeouts; no media engine change was needed. Visual hierarchy review reached92/100 after two iterations. A fresh unsigned Windows package passed native dispatch, capture, local translation, isolation and tool-asset checks. Real user configuration hashes were preserved. Final Evidence is in `.evidence/design-20261029/verification.json`; the verification section further below records the previous baseline.

The primary references are the ten products explicitly confirmed by the user. **Tracer is the design and workflow priority.** Previous references such as ShareX remain secondary. This is a capability inventory and implementation record, not a claim of full feature parity or a comparative native performance benchmark.

## Evidence and current scope

- Ten primary products, 110 documented core feature groups: `.omx/research/benchmark-20261029/catalog.json`. Groups are not an exhaustive count of every menu, setting or format combination.
- REA 6.8.0 actually ran in a disposable 1-vCPU VM using Node 24.22.1. Public frontend reconstruction completed for nine primary products. ScreenFloat's sample timed out; its failed runs remain recorded. No public website result is treated as the native app implementation.
- macshot and Snapzy: six Swift files and a license each, pinned to full repository revisions, downloaded with file hashes, reviewed, and actually imported through REA as **historical source references**. The importer reports Swift inventories with zero inferred relationships; this does not reconstruct native application behavior.
- No reference native Mac app was executed. No app icons, screenshots or website code were added to the product. Tracer posters remain inspection evidence only. The VM was stopped and the scratch project deleted after artifact retrieval.

## Product comparison

| Primary reference | OpenCapture foundation / new work | Remaining boundary |
| --- | --- | --- |
| [Tracer](https://nmuxlab.com/kr/tracer/) | Capture/markup/OCR/translation, floating pins, focus restoration, click-through, blink, drop/import and shortcut sheet. Selection preview now honors language preferences and fixes its image before asynchronous OCR initialization. | Continuous while-drag translation, favorite destination folders, dedicated window-selection semantics and global Finder drag behavior remain incomplete or unverified. |
| [macshot](https://macshot.io/) | Capture, annotations, scrolling, OCR/translation, GIF/video, redaction, background removal, styling and history have local counterparts. Selected capture/scroll/preview sources were reviewed. | Every annotation variant, native capture timing, detector accuracy and upload-provider workflows are not established as equivalent. |
| [CleanShot X](https://cleanshot.com/) | Immediate capture actions, pins, OCR, scroll capture, image editing and recording foundations. | Studio Mode refinements and hosted collaboration/transcript features require separate implementation and acceptance checks. |
| [Shottr](https://shottr.cc/) | OCR, scroll capture, image pinning, pixel inspection and redaction foundations. | Ruler imprints, object inpainting, exact erase semantics and S3 sharing are not equivalent merely because an editor exists. |
| [Xnip](https://xnipapp.com/) | Capture, OCR, annotations, numbered steps and always-on-top images. | Native shadow/multiple-window behavior and a dedicated window-selection route need verification. |
| [ScreenFloat](https://eternalstorms.at/ScreenFloat/) | Persistent pins, library, focus/blink and **new horizontal/vertical image folding**. Fold exports a new PNG, retains both sides and preserves the original. | Ratings/smart-folder refinements, native automation, track editing and exact original-layout export remain partial. Its REA frontend reconstruction timed out. |
| [Snapzy](https://snapzy.app/) | Preview actions, capture/recording, OCR, subject cutout, editor/history and styling foundations. Selected Swift flows were reviewed. | Smart element snapping, exact recording/editor refinements and cloud/URL-scheme interoperability remain separate work. Its upstream non-sandboxed build is not MAS evidence. |
| [Xnapper](https://xnapper.com/) | Auto-balanced screenshot styling, padding/radius/shadow, background/ratio presets and sensitive-text redaction foundations. | Exact preset/auto-layout parity needs fixtures; vendor-planned cloud functionality is not counted as shipped. |
| [Snagit](https://www.techsmith.com/snagit/) | Capture, local library, annotation, steps, boards and recording foundations. | Complete tutorial/document templates, advanced smart redaction and hosted/service integrations remain incomplete. Separate Camtasia/Audiate features are not attributed to Snagit. |
| [Tangerine](https://tangerineformac.com/) | Dedicated local file workbench: media, PDF, text/document, archives/RAR, floating files and native file actions. | Existing ledger: 164 core, 45 optional LibreOffice, 30 partial, 36 unsupported directed routes. Optional Office is disabled in MAS. See `.omx/plans/tangerine-coverage.json`; these are implementation categories, not 275 executed pair tests. |

## Verified additions

1. `image-fold` in the existing File tools screen, with direction, offset and removed size. Exact pixel seams were tested on both axes, including execution through the real options UI. No new navigation or resident process.
2. Capture-selection translation reads existing screen-translation language settings (`auto → ko` when empty), snapshots selected pixels before OCR initialization, retains the one-task/latest-result scheduler, and forwards unsupported pairs to the existing explicit backend error. No implicit online-engine switch.
3. `DESIGN.md` now records Tracer as the user's primary workflow/visual reference. Existing compact controls and source/result semantics remain the implementation basis.

## Verification

- Full suite: **275 passed, 1 opt-in runtime test skipped, 39 files**. Test count is unrelated to the reference's 275 conversion routes.
- Actual isolated production main/preload/UI: **24 checks passed**, including real PNG fold pixels, real UI option execution, existing PDF/RAR/media exports, responsive layouts and source hashes. The real user configuration hash remained unchanged.
- Format, lint, TypeScript, web checks and production build passed.
- Fresh unsigned Windows package passed cold/warm native dispatch, capture, local translation, isolation and bundled tool-asset checks. The packaged capture/dialog bundles match the compiled versions used by verification.
- Evidence: `.evidence/benchmark-20261029/`, `.evidence/tangerine/runtime-2026-10-29T04-27-32-471Z/qa.json`.

## Remaining sequence

1. Completed in the latest pass: explicit Window capture and registered folder destinations. macOS permission persistence and native execution remain separate requirements.
2. Extend settled-selection translation with genuinely bounded while-drag behavior and broader supported language/provider coverage; do not bypass opt-in or existing offline restrictions.
3. Validate portable scroll registration against sticky headers, scrollbars and low-information frames using the reviewed macshot/Snapzy source behaviors and deterministic fixtures.
4. Close the remaining tool/editor/service gaps with per-feature acceptance cases. Keep unsupported operations visibly unsupported.
5. Real macOS execution, native assets, bookmark persistence, Finder integration and signed App Store testing remain required. A code check is not evidence of native execution.

Detailed inputs, versions, hashes, source citations, success/failure boundaries and Tracer code links live under `.omx/research/benchmark-20261029/`.
