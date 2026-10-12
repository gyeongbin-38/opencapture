# OpenCapture Quick Launch

`OpenCaptureQuick.exe` is a small Windows-only resident launcher. It owns the
global open and capture hotkeys, shows their actual registrations in its tray
menu, and starts the sibling `OpenCapture.exe` only when the user requests an
action. It does not configure Windows startup; the main application owns that
setting.

The default capture key is `Ctrl+Shift+Space`; the default dashboard key is
`Ctrl+Alt+Space`. The helper reads the same `起始页快捷键` values as the
Electron application, reloads them when `config.json` changes, and treats an
empty value as disabled. It dispatches capture through
`OpenCapture.exe --broker --native-dispatch --capture`, so there is one
capture/editor implementation.

Normal Electron instances claim ownership in `hotkey-owner.json`. The helper
then unregisters its keys and acknowledges the transition in
`hotkey-helper-state.json`; broker processes do not claim ownership.

Build it with:

```powershell
.\scripts\build-quicklaunch.ps1
```

The output is `native/bin/OpenCaptureQuick.exe`. Package it beside
`OpenCapture.exe`, since the helper deliberately resolves only that exact
sibling path. The helper does not contain screenshot or editor code. A request
made while the main application is stopped therefore still includes the cold
startup cost of OpenCapture.

For an isolated resident-memory sample, run:

```powershell
.\scripts\measure-quicklaunch.ps1
```

The measurement script launches its own helper process, waits for its JSON
readiness report, samples that exact PID at one and three seconds, and then
stops only that PID.
