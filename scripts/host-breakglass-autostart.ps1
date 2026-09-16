param(
  [ValidateSet("install", "uninstall", "status")]
  [string]$Action = "status"
)
$ErrorActionPreference = "Stop"
$TaskName = "GPT Host Breakglass"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Supervisor = Join-Path $RepoRoot "scripts\host-breakglass-supervisor.mjs"
$StateDir = Join-Path $env:LOCALAPPDATA "gpt-repo-host-breakglass"
$EnvFile = Join-Path $StateDir "host.env"
$Node = (Get-Command node -ErrorAction Stop).Source

function Read-EnvFile([string]$Path) {
  $values = @{}
  if (-not (Test-Path $Path)) { return $values }
  foreach ($line in Get-Content $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) { continue }
    $parts = $trimmed.Split("=", 2)
    $values[$parts[0]] = $parts[1].Trim().Trim('"').Trim("'")
  }
  return $values
}

if ($Action -eq "status") {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) { Write-Output '{"installed":false}'; exit 1 }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  [pscustomobject]@{ installed=$true; state=[string]$task.State; last_run=$info.LastRunTime; last_result=$info.LastTaskResult; next_run=$info.NextRunTime } | ConvertTo-Json -Compress
  exit 0
}

if ($Action -eq "uninstall") {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  Write-Output '{"installed":false,"changed":true}'
  exit 0
}

$envValues = Read-EnvFile $EnvFile
if (-not $envValues["CONTROL_PLANE_TUNNEL_ID"]) { throw "CONTROL_PLANE_TUNNEL_ID is missing from $EnvFile" }
if (-not $envValues["CONTROL_PLANE_API_KEY"]) { throw "CONTROL_PLANE_API_KEY is missing from $EnvFile" }
$tunnelClient = $envValues["GPT_HOST_BREAKGLASS_TUNNEL_CLIENT_BIN"]
if (-not $tunnelClient) { $tunnelClient = "C:\Tools\openai-tunnel-client\v0.0.14\tunnel-client.exe" }
if (-not (Test-Path $tunnelClient)) { throw "tunnel-client binary not found at configured path" }
$configPath = $envValues["GPT_HOST_BREAKGLASS_CONFIG"]
if (-not $configPath) { $configPath = Join-Path $RepoRoot "config.host-breakglass.local.json" }
if (-not (Test-Path $configPath)) { throw "Host Breakglass config not found at configured path" }
$config = Get-Content $configPath -Raw | ConvertFrom-Json
if ($config.enabled -ne $true) { throw "Host Breakglass config is not enabled" }
if ($config.computer_use -and $config.computer_use.enabled -eq $true) {
  $guiUrl = [Uri]$(if ($config.computer_use.server_url) { $config.computer_use.server_url } else { 'http://127.0.0.1:3107/mcp' })
  if ($guiUrl.Scheme -ne 'http' -or $guiUrl.Host.Trim('[', ']') -notin @('127.0.0.1', 'localhost', '::1') -or $guiUrl.AbsolutePath.TrimEnd('/') -ne '/mcp' -or $guiUrl.UserInfo -or $guiUrl.Query -or $guiUrl.Fragment) {
    throw 'Computer-Use target must be an unauthenticated loopback MCP URL'
  }
  # GUI runtime availability is optional; policy validation is not.
}

$taskAction = New-ScheduledTaskAction -Execute $Node -Argument ('"{0}"' -f $Supervisor) -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Description "Independent GPT Repo Host Breakglass supervisor. Starts after user logon without AWA/RDC dependency." -Force | Out-Null
Write-Output '{"installed":true,"changed":true}'
