$ErrorActionPreference='Stop'
$owned=$null
$generation=$null
function Publish($value){[Console]::Out.WriteLine(($value|ConvertTo-Json -Compress -Depth 5));[Console]::Out.Flush()}
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'host-breakglass-tunnel-job.cs')
  $inputReader=[IO.StreamReader]::new([Console]::OpenStandardInput())
  $spec=$inputReader.ReadLine()|ConvertFrom-Json
  $generation=[string]$spec.generation
  if($generation -notmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'){throw 'Invalid generation'}
  if(-not [IO.Path]::IsPathRooted($spec.executable) -or -not [IO.Path]::IsPathRooted($spec.cwd)){throw 'Absolute paths required'}
  $owned=[BreakglassTunnelJob]::new($spec.executable,[string[]]$spec.args,$spec.cwd,$spec.stdout,$spec.stderr)
  Publish @{type='spawned';generation=$generation;pid=$owned.Pid;creation_filetime=[string]$owned.CreationFileTime;members=@($owned.Members())}
  $read=$inputReader.ReadLineAsync()
  $reportedExit=$false
  while($true){
    if(-not $reportedExit -and $owned.RootExited){$reportedExit=$true;Publish @{type='root_exit';generation=$generation;members=@($owned.Members())}}
    if($read.Wait(25)){
      $line=$read.Result
      if($null -eq $line){$clean=$owned.Stop(5000);break}
      $command=$line|ConvertFrom-Json
      if($command.generation -ne $generation){throw 'Wrong command generation'}
      if($command.type -eq 'members'){Publish @{type='members';generation=$generation;members=@($owned.Members())}}
      elseif($command.type -eq 'listener'){
        $port=[int]$command.port
        if($port -lt 1 -or $port -gt 65535){throw 'Invalid listener port'}
        $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
        $mine=@($owned.Members())
        $matches=@($listeners|Where-Object {$_.LocalAddress -eq '127.0.0.1' -and $_.OwningProcess -eq $owned.Pid -and $_.OwningProcess -in $mine})
        Publish @{type='listener';generation=$generation;port=$port;owned=($matches.Count -eq 1 -and $listeners.Count -eq 1)}
      }
      elseif($command.type -eq 'terminate-root'){$owned.TerminateRoot()}
      elseif($command.type -eq 'stop'){$clean=$owned.Stop(5000);Publish @{type='stopped';generation=$generation;clean=$clean;members=@($owned.Members())};break}
      else{throw 'Unknown ownership command'}
      $read=$inputReader.ReadLineAsync()
    }
  }
} catch {
  # Never echo launch inputs, environment values or arbitrary backend errors.
  $clean=$false
  if($null -ne $owned){try{$clean=$owned.Stop(5000)}catch{}}
  else{try{$clean=[BreakglassTunnelJob]::LastFailureClean}catch{}}
  $reason='ownership_unconfirmed'
  try{if([BreakglassTunnelJob]::FailureStage){$reason=[BreakglassTunnelJob]::FailureStage}}catch{}
  Publish @{type='owner_error';generation=$generation;clean=$clean;reason=$reason}
  exit 1
} finally {if($null -ne $owned){$owned.Dispose()}}
