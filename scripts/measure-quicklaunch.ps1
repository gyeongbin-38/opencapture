[CmdletBinding()]
param(
    [string]$ExecutablePath = ""
)

$ErrorActionPreference = "Stop"
if (-not $ExecutablePath) { $ExecutablePath = Join-Path (Split-Path -Parent $PSScriptRoot) "native\bin\OpenCaptureQuick.exe" }
$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
$diagnosticsPath = Join-Path ([System.IO.Path]::GetTempPath()) ("OpenCaptureQuick-{0}.json" -f [Guid]::NewGuid().ToString("N"))
$profilePath = Join-Path ([System.IO.Path]::GetTempPath()) ("OpenCaptureQuick-profile-{0}" -f [Guid]::NewGuid().ToString("N"))
$process = $null

try {
    New-Item -ItemType Directory -Path $profilePath -Force | Out-Null
    $process = Start-Process -FilePath $resolvedExecutable -ArgumentList @(
        "--diagnostics", $diagnosticsPath,
        "--userData", $profilePath,
        "--test-instance", ([Guid]::NewGuid().ToString("N"))
    ) -WindowStyle Hidden -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $diagnosticsPath -PathType Leaf)) {
        if ($process.HasExited) {
            throw "OpenCaptureQuick exited before reporting readiness (exit code $($process.ExitCode)). Another instance may already be running."
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            throw "Timed out waiting for OpenCaptureQuick diagnostics."
        }
        Start-Sleep -Milliseconds 50
        $process.Refresh()
    }

    $ready = Get-Content -LiteralPath $diagnosticsPath -Raw | ConvertFrom-Json
    if ([int]$ready.pid -ne $process.Id) {
        throw "Diagnostics PID $($ready.pid) does not match owned process PID $($process.Id)."
    }

    $samples = foreach ($delay in @(1, 2)) {
        Start-Sleep -Seconds $delay
        $owned = Get-Process -Id $process.Id -ErrorAction Stop
        [pscustomobject]@{
            ElapsedSeconds = if ($delay -eq 1) { 1 } else { 3 }
            WorkingSetBytes = $owned.WorkingSet64
            PrivateMemoryBytes = $owned.PrivateMemorySize64
        }
    }

    [pscustomobject]@{
        Executable = $resolvedExecutable
        ExecutableBytes = (Get-Item -LiteralPath $resolvedExecutable).Length
        ProcessId = $process.Id
        StartupMilliseconds = [int64]$ready.startupMs
        ToggleHotkey = $ready.toggle
        CaptureHotkey = $ready.capture
        ChildProcessCount = @(Get-CimInstance Win32_Process -Filter ("ParentProcessId={0}" -f $process.Id)).Count
        Samples = $samples
    } | ConvertTo-Json -Depth 5
}
finally {
    if ($null -ne $process) {
        $process.Refresh()
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force
            $process.WaitForExit(5000) | Out-Null
        }
        $process.Dispose()
    }
    Remove-Item -LiteralPath $diagnosticsPath -Force -ErrorAction SilentlyContinue
    $resolvedProfilePath = [System.IO.Path]::GetFullPath($profilePath)
    $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
    if ((Split-Path -Parent $resolvedProfilePath) -ne $resolvedTempRoot -or
        -not [System.IO.Path]::GetFileName($resolvedProfilePath).StartsWith('OpenCaptureQuick-profile-', [System.StringComparison]::Ordinal)) {
        throw "Measurement cleanup target is outside its generated temporary profile."
    }
    Remove-Item -LiteralPath $profilePath -Recurse -Force -ErrorAction SilentlyContinue
}
