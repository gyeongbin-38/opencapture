param([string]$Executable = "release/win-unpacked/OpenCapture.exe", [string]$Report = ".evidence/editor-baseline.json", [string]$ExtraArgument = "")
$ErrorActionPreference = 'Stop'
$workspace = Split-Path $PSScriptRoot -Parent
$exePath = (Resolve-Path (Join-Path $workspace $Executable)).Path
$profile = Join-Path $workspace '.evidence/benchmark-profile'
New-Item -ItemType Directory -Path $profile -Force | Out-Null
$clock = [Diagnostics.Stopwatch]::StartNew()
$arguments = @("--userData=`"$profile`"")
if ($ExtraArgument) { $arguments += $ExtraArgument }
$launched = Start-Process -FilePath $exePath -ArgumentList $arguments -WindowStyle Hidden -PassThru
$ownedIds = @($launched.Id)
try {
    $firstWindowMs = $null
    while ($clock.ElapsedMilliseconds -lt 5000) {
        $launched.Refresh()
        if ($launched.HasExited) { throw 'Benchmark process exited before readiness' }
        if ($launched.MainWindowHandle -ne 0) { $firstWindowMs = $clock.ElapsedMilliseconds; break }
        Start-Sleep -Milliseconds 50
    }
    Start-Sleep -Seconds 3
    $processes = Get-CimInstance Win32_Process
    do {
        $priorCount = $ownedIds.Count
        $ownedIds = @($ownedIds + @($processes | Where-Object { $ownedIds -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId }) | Select-Object -Unique)
    } while ($ownedIds.Count -gt $priorCount)
    $samples = @($ownedIds | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | ForEach-Object { [pscustomobject]@{pid=$_.Id;name=$_.ProcessName;workingSetBytes=$_.WorkingSet64;privateBytes=$_.PrivateMemorySize64} })
    $result = [pscustomobject]@{ executable=$exePath;firstWindowMs=$firstWindowMs;elapsedMs=$clock.ElapsedMilliseconds;workingSetBytes=($samples | Measure-Object -Property workingSetBytes -Sum).Sum;privateBytes=($samples | Measure-Object -Property privateBytes -Sum).Sum;processCount=$samples.Count;processes=$samples;note='One local run; first window handle is not proof of capture readiness.' }
    $result | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $workspace $Report)
    $result | Select-Object firstWindowMs,workingSetBytes,privateBytes,processCount | ConvertTo-Json
} finally {
    foreach ($ownedId in $ownedIds) { Stop-Process -Id $ownedId -ErrorAction SilentlyContinue }
}
