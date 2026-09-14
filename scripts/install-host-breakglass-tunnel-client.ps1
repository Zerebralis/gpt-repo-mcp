param(
  [string]$InstallRoot = "C:\Tools\openai-tunnel-client"
)
$ErrorActionPreference = "Stop"
$Version = "0.0.14"
$ArchiveName = "tunnel-client-v$Version-windows-amd64.zip"
$ExpectedSha256 = "784AB8DA7B5A88F0109F1FD8AAF0A1C86067430B896DDDF307EF7E3CC49FA1A5"
$ReleaseBase = "https://github.com/openai/tunnel-client/releases/download/v$Version"
$Archive = Join-Path $InstallRoot $ArchiveName
$ExtractRoot = Join-Path $InstallRoot "v$Version"

New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
Invoke-WebRequest -UseBasicParsing "$ReleaseBase/$ArchiveName" -OutFile $Archive
$Actual = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToUpperInvariant()
if ($Actual -ne $ExpectedSha256) {
  Remove-Item $Archive -Force -ErrorAction SilentlyContinue
  throw "Tunnel client archive SHA-256 mismatch."
}
if (Test-Path $ExtractRoot) { Remove-Item $ExtractRoot -Recurse -Force }
Expand-Archive -Path $Archive -DestinationPath $ExtractRoot
$Exe = Get-ChildItem $ExtractRoot -Filter "tunnel-client.exe" -File -Recurse | Select-Object -First 1
if (-not $Exe) { throw "tunnel-client.exe missing after extraction." }
$VersionOutput = & $Exe.FullName --version
if ($LASTEXITCODE -ne 0 -or ($VersionOutput -join " ") -notmatch "0\.0\.14") {
  throw "Installed tunnel-client did not report the pinned version."
}
[pscustomobject]@{
  ok = $true
  version = $Version
  sha256 = $Actual
  executable = $Exe.FullName
} | ConvertTo-Json -Compress