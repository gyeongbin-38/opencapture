# OpenCapture convenience and footprint research

Current user-confirmed product targets and 2026-10-29 integration evidence: [Benchmark progress](BENCHMARK_PROGRESS.md). The observations below remain the dated 2026-10-09 baseline.

Checked 2026-10-09 against official product/upstream sources. Package sizes are compressed download observations, not RAM or startup measurements; formats and included system runtimes differ.

| Reference | License / role | Adopted idea |
|---|---|---|
| [Greenshot](https://github.com/greenshot/greenshot) | GPL-3.0; Windows .NET Framework app | Small Windows capture entry point separate from heavier editing. Current observed portable download 3.6 MiB; system .NET prerequisite matters. |
| [Flameshot](https://github.com/flameshot-org/flameshot) | GPL-3.0 | Tray/CLI capture, immediate selection workflow; observed portable ZIP 53.0 MiB. |
| [ShareX](https://github.com/ShareX/ShareX) | GPL-3.0 | Configurable after-capture tasks, preserve originals, history, combine. [Background-removal models](https://getsharex.com/docs/background-remover) are optional payloads. |
| [ksnip](https://github.com/ksnip/ksnip) | GPL-3.0 | Multiple images, pinning, single-instance CLI forwarding. Latest stable observed 1.10.1 from 2023; project seeks co-maintainers. |
| [Snipaste](https://www.snipaste.com/) | Product benchmark, not imported source | Thumbnail/collapse mode, groups, recoverable capture history. |
| [CleanShot](https://cleanshot.com/) | macOS product benchmark, not imported source | Immediate copy/save/reuse and low-friction capture history. |
| [XCap](https://github.com/nashaofu/xcap) | Apache-2.0 | Future native cross-platform capture core candidate; not a ready replacement for editor/history. |
| [rembg](https://github.com/danielgatis/rembg) | MIT code; model licenses separate | Reused U2NetP ONNX model integration already in this project, local inference and explicit model lifecycle. |

No repository was added just for its feature count. Existing eSearch GPL code, ONNX Runtime and image helpers are reused; the small Windows launcher/capture helper is project code built against the system .NET Framework, adding no new NuGet/npm dependency.

## Implemented direction

- Small `OpenCaptureQuick.exe` owns native global hotkeys, region selection and safe PNG saving. Capture-only use does not launch Electron; the editor is invoked on demand. Its cold launch remains a separate cost.
- User-owned shortcut conflicts are respected. Registration failures use a declared fallback or visibly remain unavailable. No claim of universal zero conflict; Windows reserves keys and other applications may already own them.
- No PrintScreen, Windows-key combination or Ctrl+Shift+Esc takeover. Main editor prioritizes existing configured shortcuts before new convenience defaults.
- Compact panel and renderer disposal on hide; broker-launched editor exits after all windows close and queued processing finishes.
- ONNX loads only when needed; segmentation sessions and translation subprocesses retire after 45 seconds idle.
- Persistent multi-capture metadata has no silent 1,000-item truncation. UI pages 80 items initially; asynchronous thumbnail decoding has four slots and a 200-entry memory cache.
- Batch pin, non-overwriting export, vertical/horizontal merge. Automatic cutout/copy/pin is opt-in, retains original and falls back to original if cutout fails.

## Local measurements

Single-machine observations, not representative hardware benchmarks:

| Measurement | Result | Boundary |
|---|---:|---|
| Previous editor process-tree working-set sum | 370,376,704 bytes (~353.2 MiB), 5 processes | Editor running, not helper-only standby; shared pages can be counted in multiple process working sets. |
| Quick Launch executable | 27,648 bytes | Uses the system .NET Framework and includes the native selector. |
| Helper startup to key registration | 87–155 ms | Recent local observations; not screenshot or editor cold-start latency. |
| Helper standby working set | 32,309,248 bytes (~30.8 MiB) | One resident managed process, sampled at 1 and 3 seconds. |
| Helper private memory | 24,645,632 bytes (~23.5 MiB) | Same observation. |
| Packaged editor + 1,005-item test library ready | 914 ms | Latest repeated run (earlier 1,317 and 2,986 ms); includes test connection and state/thumbnail response, with caches/system load uncontrolled; not a precise capture-ready benchmark. |

Evidence: `.evidence/editor-baseline.json`, `.evidence/quicklaunch-measure-final.json`, `.evidence/convenience.json`. Repeat with scripts/measure-editor.ps1 and scripts/measure-quicklaunch.ps1. Total full-package disk footprint remains much larger than native-only capture tools because Chromium, Python/translation runtime and FFmpeg are still available. Standby memory reduction is not a claim of a tiny complete distribution.

## Future development candidates

1. Optional feature packs for recording and translation, with signed/versioned manifests and rollback; do not simply omit required runtimes and leave broken buttons.
2. Native capture core on macOS via XCap or platform APIs, with permissions/DPI tests on an actual Mac.
3. Persistent capture groups with session restoration, searchable OCR cache, and user-controlled retention limits.
4. Drag a selected capture into another app, privacy redaction presets, and non-destructive annotations.

Official design references: [Win32 RegisterHotKey](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey), [Electron performance](https://www.electronjs.org/docs/latest/tutorial/performance), [Electron shortcuts](https://www.electronjs.org/docs/latest/api/global-shortcut). A global hotkey needs a live owner; hiding the editor does not remove that requirement.
