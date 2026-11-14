# Local file tools

The library's **File tools** button, command search (`Ctrl/Cmd+K`, then “파일 도구” or “convert”), and file drops on Home/Library open the file workbench. Existing image-only drops retain the image preview converter. Mixed selections retain every source and show compatible counts; source checkboxes choose what a recipe processes. Convert, Tools and Actions use Alt+1/2/3, arrow keys, Enter and Escape. File and folder pickers are separate.

Processing stays local. FFmpeg is probed on first use. A destination picker precedes processing; results use new names rather than replacing existing files. Each source has a success/error/cancel outcome and failed-only retry. Cancellation preserves completed results. New sender-owned source/output IDs prevent other windows from operating on a result; navigation revokes handles and cancels work. Normal files remain unchanged. Move is a separate explicit action using Windows native no-overwrite relocation on the same device; other platforms and cross-device movement remain unavailable.

## Implemented engines

- Image/media: existing image converter plus FFmpeg. Actual generated and re-decoded outputs: JPG, PNG, WebP, TIFF, AVIF, BMP; MP3, M4A, WAV, FLAC, OGG, Opus, AIFF, WMA; MP4, MOV, MKV, WebM, AVI, WMV, GIF. HEIC inputs require a successful real decode probe; HEIC encoding is unavailable. SVG input remains in the existing Chromium image converter.
- Images: multi-page raster PDF, collage, fixed neutral frame, solid rectangle redaction, and the existing image/annotation editor.
- PDF: lazy-loaded PDF.js in a dedicated sandboxed renderer and pdf-lib in main. All-page 300 DPI PNG/JPEG, text and plain-paragraph Markdown extraction, split, merge, page reordering/duplication/rotation, Info/XMP removal and structural optimization. Scanned pages without embedded text report that OCR is needed. Optimization reports when size does not decrease.
- Text: TXT/Markdown/HTML, SRT/WebVTT/ASS text conversion, quoted CSV/TSV/JSON tables. Formula-like cells are preserved with a warning; document layout and workbook semantics are not invented.
- Document text: TXT/Markdown/HTML/EPUB to real minimal DOCX/EPUB and text exports. PDF text can also become DOCX/EPUB. These outputs retain text only, not the original layout, images or advanced formatting. Scanned PDF pages need OCR first.
- Document pages: TXT/Markdown/HTML/EPUB can be printed locally to a text-only PDF and exported as PNG/JPG pages. Text printing is limited to 128 KiB, 4000 visual lines and 200 pages. Original fonts, pagination and images are not retained. Office-family PNG/JPG export chains installed LibreOffice PDF conversion with the sandboxed PDF renderer; its layout may differ from the source application.
- Office: optional installed LibreOffice, found lazily in known system/PATH locations. Fixed Writer/Calc/Impress filters, separate macro/link-update profiles, source preservation and output validation. The app does not install or bundle LibreOffice. Eight real conversions and cancellation were verified in a disposable Ubuntu26.04/LibreOffice26.2.6.3 VM; this does not establish Mac/Windows engine fidelity. The external process uses its own OS permissions rather than the PDF renderer's sandbox.
- Archives: bounded ZIP and USTAR create/inspect/test/extract, ZIP↔TAR and archive-member repacking, GZIP/Brotli and TAR.GZ/TAR.BR. ZIP64, encryption, links, special files and GNU/PAX TAR extensions are rejected explicitly. Expanded size/count/ratio bounds and CRC/checksum/read-back checks apply.
- RAR: a dedicated bounded WASM runtime supports RAR4/5 inspection, extraction and repacking to ZIP/TAR/GZIP. The sandboxed renderer streams bounded chunks to validated main-process paths. Limits are 100 MiB input, 256 MiB expanded output, 5000 entries, and 384 MiB maximum WASM memory (16 MiB initial). Encrypted RAR is rejected. Actual fixture execution and cancellation are recorded in `.evidence/rar-e2e/report.json`; this is not every RAR variant or every repacking combination.

## Reference coverage

Research used the [Tangerine official site](https://tangerineformac.com/), its public simulated demo, and [REA](https://github.com/morluto/rea) in a disposable VM. The reference catalog has 275 directed conversion routes, 26 tools and six file actions. Those numbers are an inventory, not a count of implemented or verified OpenCapture features. No reference source, graphics or branding is included in product code.

| Reference tool | OpenCapture implementation and limit |
| --- | --- |
| Compress | Image/audio/video quality controls and archive compression; no target-byte optimizer or general PDF compression |
| Metadata | Media/image stripping and PDF Info/XMP removal; full metadata editor remains pending; embedded attachments are not removed |
| Edit photo | Existing image editor through Edit action |
| Annotate photo | Existing image annotation editor through Edit action |
| Frame/background | Neutral frame plus existing library/board beautify controls |
| Crop image | Fixed validated pixel rectangle |
| Normalize audio | Real FFmpeg loudness normalization |
| Mute video | Export without an audio stream |
| Trim video | Start/end export |
| Split PDF | Selected pages into individual PDFs |
| Organize PDF | Reorder/duplicate selected pages and rotate; default rotation is zero |
| Extract archive | ZIP/USTAR/GZIP/Brotli and bounded RAR4/5; restricted extended/encrypted formats remain unavailable |
| Create PDF | 1–100 raster image pages |
| Merge PDF | Merge at least two PDFs while retaining page content |
| Crop video | Validated pixel rectangle |
| Change video speed | Export retiming, including audio tempo; 0.25–4× |
| Join videos | Multi-source export retaining audio, with silence inserted for sources without audio |
| Video snapshots | One frame at a selected timestamp; range/series extraction pending |
| Split video | Two files at one selected split point; arbitrary multi-split pending |
| Audio to video | Animated waveform with audio; custom still-image composition and advanced waveform controls remain limited |
| Trim audio | Start/end export |
| Audio channels | Mono/stereo export |
| Collage | Bounded multi-image grid |
| Redact image | Solid rectangle and existing editor; automatic detection pending |
| Redact video | Time-bounded solid rectangle; tracking/detection pending |
| Redact audio | Time-bounded silence; censor-tone customization pending |

| Reference action | OpenCapture implementation and limit |
| --- | --- |
| AirDrop | macOS native share picker code; real Mac execution pending; disabled elsewhere |
| Float | Dedicated sandboxed floating shelf for mixed files/folders; selection, copy, path, reveal and native drag dispatch; 240px minimum width |
| Copy | Native Windows file/folder clipboard helper; macOS single-file URL and Linux URI-list paths require real platform verification |
| Move | Windows same-device native no-overwrite operation; unavailable elsewhere |
| Copy Path | Selected full paths as text |
| Terminal | Windows/macOS containing-folder launch; disabled for MAS and unsupported platforms |

## Remaining requirements

Registered library collections can be chosen as destinations for exports and copy/move operations. The renderer receives opaque IDs and display names; the main process re-resolves the current collection, canonicalizes an absolute existing directory, and reuses the existing cancellation/no-overwrite pipeline. Removing or losing access to a collection produces an explicit error. The default remains the native folder picker, and choosing an export destination does not change the active capture collection. Saved destinations are disabled in MAS until security-scoped permission persistence is implemented.

Loaded source rows collapse behind their selected/total count. Expanding the labelled button retains individual file selection. The current operation names its options, and the fixed footer keeps the destination and run/cancel actions reachable. The floating file shelf uses accessible40px icon handles with its original native drag event.

The user's autonomous dependency decision authorized `pdf-lib@1.17.1` and `pdfjs-dist@6.4.299`; both load only during PDF work. Browser-only PDF assets are bundled locally, and unused Node PDF.js/canvas packages are excluded from distribution. Office/legacy Office and Pages input depend on installed LibreOffice in direct-distribution builds; external LibreOffice discovery and execution are disabled in MAS. Pages output and HEIC output remain unavailable. EPUB input now supports text-only conversion and page export, not original ebook-layout/image preservation. PDF-to-DOCX/EPUB retains text but does not reconstruct the original editable layout or produce editable slides/workbooks. The bounded RAR runtime is separate from stock libarchive.js, which was rejected because its whole-entry allocation cannot enforce the required limits.

Finder-wide modifier dragging is not implemented by the dashboard dialog. Real macOS native modules, file scopes/bookmarks, FFmpeg assets, clipboard/share behavior and signed App Store execution remain unverified. This work does not remove existing Mac readiness blockers.

## Verification

`npm test` includes media, text, archive, PDF, external-process lifecycle, shelf and file-service regressions. `scripts/verify-file-tools.cjs` runs the production main/preload/UI with an absolute isolated profile, asserts the active path, checks real exports/source hashes/PDF operations, runs the dialog's MP3 action, and captures actual 1180/850/380/360px dialogs plus 320/240px shelves. It also rejects preload builds that require unsupported relative chunks. The exact `OPENCAPTURE_FILE_TOOLS_OK` completion marker is required; the real profile's config hash must remain unchanged. Scratch REA and Office VMs/projects are stopped/removed after evidence retrieval.

The capability inventory and source evidence are in `.omx/research/tangerine-matrix.json` and `.omx/research/rea-usage.md`; per-route implementation coverage is in `.omx/plans/tangerine-coverage.json`. Runtime evidence is in `.evidence/tangerine/` and `.evidence/rar-e2e/report.json`. Representative media output tests, Linux-only LibreOffice samples and actual Electron checks have different scopes; none establishes that all 275 reference pairs were individually tested. The final E2E count belongs to the root's fresh final report rather than this documentation snapshot.
