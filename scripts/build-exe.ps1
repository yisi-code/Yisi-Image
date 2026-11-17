$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root 'launcher'
$dist = Join-Path $root 'dist'
$release = Join-Path $root 'release'
$zip = Join-Path $launcher 'WebAssets.zip'
$tempExe = Join-Path $release 'YisiImageTool.exe'
$finalExe = Join-Path $release 'Yisi图像工具.exe'
$instructions = Join-Path $release '使用说明.txt'

Push-Location $root
try {
    Write-Host '[1/3] Building web assets...'
    & pnpm build
    if ($LASTEXITCODE -ne 0) {
        throw 'pnpm build failed.'
    }

    if (!(Test-Path (Join-Path $dist 'index.html'))) {
        throw 'dist/index.html was not generated.'
    }

    Write-Host '[2/3] Packing embedded web assets...'
    if (Test-Path $zip) {
        Remove-Item -LiteralPath $zip -Force
    }
    Compress-Archive -Path (Join-Path $dist '*') -DestinationPath $zip -CompressionLevel Optimal -Force

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
    try {
        $names = @($archive.Entries | ForEach-Object { $_.FullName })
        if ($names -notcontains 'index.html') {
            throw 'WebAssets.zip does not contain index.html at its root.'
        }
    }
    finally {
        $archive.Dispose()
    }

    Write-Host '[3/3] Compiling launcher...'
    New-Item -ItemType Directory -Force -Path $release | Out-Null
    if (Test-Path $tempExe) {
        Remove-Item -LiteralPath $tempExe -Force
    }
    if (Test-Path $finalExe) {
        Remove-Item -LiteralPath $finalExe -Force
    }

    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (!(Test-Path $csc)) {
        $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
    }
    if (!(Test-Path $csc)) {
        throw '.NET Framework C# compiler (csc.exe) was not found.'
    }

    $icon = Join-Path $launcher 'icon.ico'
    $manifest = Join-Path $launcher 'app.manifest'
    $sources = @(Get-ChildItem -LiteralPath $launcher -Filter '*.cs' | Sort-Object Name | ForEach-Object { $_.FullName })
    $webExtensions = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Web.Extensions.dll'
    if (!(Test-Path -LiteralPath $webExtensions)) {
        $webExtensions = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\System.Web.Extensions.dll'
    }
    if (!(Test-Path -LiteralPath $webExtensions)) {
        throw 'System.Web.Extensions.dll was not found.'
    }

    $cscArgs = @(
        '/nologo',
        '/target:winexe',
        '/platform:anycpu',
        '/optimize+',
        '/codepage:65001',
        ('/win32icon:' + $icon),
        ('/win32manifest:' + $manifest),
        ('/resource:' + $zip + ',WebAssets.zip'),
        '/reference:System.dll',
        '/reference:System.Core.dll',
        '/reference:System.Drawing.dll',
        '/reference:System.Windows.Forms.dll',
        '/reference:System.IO.Compression.dll',
        '/reference:System.IO.Compression.FileSystem.dll',
        ('/reference:' + $webExtensions),
        ('/out:' + $tempExe)
    )
    $cscArgs += $sources

    & $csc $cscArgs
    if ($LASTEXITCODE -ne 0) {
        throw 'csc.exe failed.'
    }

    Move-Item -LiteralPath $tempExe -Destination $finalExe

    $guideSource = Join-Path $launcher '使用说明.txt'
    if (!(Test-Path $guideSource)) {
        throw 'launcher/使用说明.txt was not found.'
    }
    Copy-Item -LiteralPath $guideSource -Destination $instructions -Force

    $sizeMb = [Math]::Round((Get-Item -LiteralPath $finalExe).Length / 1MB, 2)
    Write-Host ''
    Write-Host ('Built: ' + $finalExe + ' (' + $sizeMb + ' MB)')
    Write-Host ('Guide: ' + $instructions)
}
finally {
    Pop-Location
}
