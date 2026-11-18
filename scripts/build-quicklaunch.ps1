[CmdletBinding()]
param(
    [switch]$Verify
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourcePaths = @(
    (Join-Path $repositoryRoot "native\QuickLaunch.cs"),
    (Join-Path $repositoryRoot "native\NativeCapture.cs")
)
$outputDirectory = Join-Path $repositoryRoot "native\bin"
$outputPath = Join-Path $outputDirectory "OpenCaptureQuick.exe"
$compiler = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw "The .NET Framework C# compiler was not found at $compiler"
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
& $compiler /nologo /target:winexe /optimize+ /platform:anycpu /out:$outputPath /reference:System.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.Windows.Forms.dll $sourcePaths
if ($LASTEXITCODE -ne 0) {
    throw "Quick Launch compilation failed with exit code $LASTEXITCODE"
}

$file = Get-Item -LiteralPath $outputPath
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$hashStream = [System.IO.File]::OpenRead($outputPath)
try {
    $hashText = ([System.BitConverter]::ToString(
        $sha256.ComputeHash($hashStream)
    )).Replace("-", "").ToLowerInvariant()
} finally {
    $hashStream.Dispose()
    $sha256.Dispose()
}
$result = [pscustomobject]@{
    Path = $file.FullName
    Bytes = $file.Length
    Sha256 = $hashText
    LastWriteTimeUtc = $file.LastWriteTimeUtc
}
$result

if ($Verify) {
    & node (Join-Path $repositoryRoot "scripts\verify-quicklaunch.cjs")
    if ($LASTEXITCODE -ne 0) {
        throw "Quick Launch verification failed with exit code $LASTEXITCODE"
    }
}
