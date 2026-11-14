# macOS packaging and Mac App Store readiness

OpenCapture has two deliberately separate macOS paths:

- `darwin`: a normal DMG and ZIP for direct distribution.
- `mas`: the sandboxed Electron MAS target. This path is configuration-only and blocked from packaging until the product and Apple-account gates below are resolved.

Loading either builder configuration is read-only. It does not run `pnpm install`, rebuild native modules, download unpinned runtimes, sign, notarize, or upload anything. Asset preparation remains a `beforePack` action and uses only the existing pinned asset manifest.

## Commands

Windows and Linux can validate the configuration without packaging:

```bash
node scripts/pack-macos.cjs --check
node scripts/pack-macos.cjs --check --mas
```

The MAS check is expected to exit nonzero while submission blockers remain. To include compiled-output and native-module gates:

```bash
node scripts/pack-macos.cjs --check --full --arch arm64
node scripts/pack-macos.cjs --check --full --arch x64
```

Actual packaging is accepted only on macOS:

```bash
node scripts/pack-macos.cjs
node scripts/pack-macos.cjs --arch arm64
node scripts/pack-macos.cjs --arch x64
node scripts/pack-macos.cjs --arch all
```

The default package command selects the current Mac host architecture. `--arch all` is an explicit cross-architecture request and requires both sets of native dependencies. The normal path produces DMG and ZIP artifacts. The packer never installs missing dependencies. Run the repository's locked dependency install on the Mac first, then resolve every full-readiness blocker.

Suggested package scripts for the root-owned `package.json`:

```json
{
    "mac:check": "node scripts/pack-macos.cjs --check",
    "mac:check:full": "node scripts/pack-macos.cjs --check --full",
    "mac:pack": "npm run build && node scripts/pack-macos.cjs",
    "mas:check": "node scripts/pack-macos.cjs --check --mas"
}
```

## Native assets and capability gaps

Each requested architecture must have its lockfile-selected Darwin builds for `onnxruntime-node`, `node-screenshots`, and `uiohook-napi`. Their absence blocks packaging. The macOS package excludes the Windows quick-launch executable, Windows Python runtime, Windows FFmpeg, `copy.exe`, and Windows/Linux native modules.

The generated Info.plist includes separate camera, microphone, system-audio capture, and screen-capture usage descriptions. `NSAudioCaptureUsageDescription` is kept distinct for system audio capture on current macOS versions.

There is currently no pinned macOS Python/local-translation runtime and no pinned native macOS FFmpeg in the repository. Do not add an unverified URL or checksum to make the check green. Local translation remains an explicit warning because online translation providers are still available. Missing FFmpeg blocks packaging because the macOS recorder selects the bundled `lib/ffmpeg/ffmpeg` path for required post-processing.

LibreOffice conversion is disabled in MAS before executable discovery or process creation. Normal direct-distribution builds can still use an installed copy. The external engine is not a bundled signed sandbox helper. macOS file copying currently supports one selected file at a time; the workbench and floating shelf receive this capability from main and disable over-limit copies. Copy Path continues to support multiple selections.

## Verification isolation

Every verifier that loads the production main process must pass an absolute `--userData` test path and assert the effective path after main initialization. Calling `app.setPath` alone is insufficient because the application initializes its own profile path. A child exit code of zero is insufficient evidence: require the scenario completion marker and its result artifact. Keep recording fixtures and saves inside that test profile or its evidence directory.

For a signed MAS test, use a dedicated test app/container and a writable location inside that container. Do not point destructive or recovery tests at the user's application container. Preserve unknown settings rather than guessing their previous values; back up metadata before removing proven test-owned entries.

## MAS blockers

MAS uses the App Sandbox and the MAS Electron build. Configuration and entitlement XML alone do not make the product ready for the store.

Global `uiohook`, Apple Events clipboard automation, `crashReporter` and pin-to-application focus tracking have MAS guards. The application-link menu is absent in MAS, and direct callbacks return before native window enumeration or focus timers. `npm run mac:verify` executes the production guards in isolated JavaScript contexts and checks that normal builds retain their lazy focus lookup. These checks do not emulate macOS permissions or prove signed App Sandbox behavior. Temporary Apple Events exceptions are not added as a shortcut.

Submission remains blocked by all of the following:

1. Persistent external-folder access needs a complete security-scoped bookmark lifecycle. `user-selected.read-write` covers user-mediated open/save panels but does not make previously stored arbitrary paths permanently accessible.
2. A real Team ID/application group, matching App ID, distribution certificate, and provisioning profile must be configured. Placeholder identifiers are intentionally absent.
3. Camera, microphone, screen capture, save/open panels, recording, native modules, and all disabled-MAS Electron APIs require testing in a signed sandboxed build on macOS.
4. App Store metadata, privacy declarations, screenshots, review notes, signing, Transporter upload, and review are external release work and are not performed by these scripts.

The readiness command keeps these as blocking failures. It must not be reworded as an App Store-ready result until the implementation and signed-Mac evidence exist.

## Official references

- Electron, [Mac App Store Submission Guide](https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide)
- Electron, [Security-scoped resource lifetime](https://www.electronjs.org/docs/latest/api/app#appstartaccessingsecurityscopedresourcebookmarkdata-mas)
- Apple, [Embedding a helper tool in a sandboxed app](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app)
- electron-builder v26, [macOS configuration](https://www.electron.build/v26/docs/mac/)
- electron-builder v26, [Mac App Store configuration](https://www.electron.build/v26/docs/mas/)
- Apple, [Accessing files from the macOS App Sandbox](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox)
- Apple, [App Sandbox temporary exception entitlements](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/AppSandboxTemporaryExceptionEntitlements.html)
