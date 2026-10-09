[CmdletBinding()]
param()

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
[pscustomobject]@{
    Path = $file.FullName
    Bytes = $file.Length
    LastWriteTimeUtc = $file.LastWriteTimeUtc
}
