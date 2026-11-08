<#
Starts the Atlas Animator editor fully detached (it keeps running after this window or terminal closes) and opens the browser.

  start-atlas-animator.ps1 [-Port 5211] [-DataDir <absolute folder>] [-NoBrowser] [-Stop]

- Runs the editor from the checkout this script lives in (tools/atlas-animator/..\..), so it works from any worktree path.
- Starts it with WMI Win32_Process.Create: the process is not a child of this shell, so closing the shell does not kill it
  (Start-Process children die with the shell). The launcher sets ATLAS_EDITOR_USER_DATA=1, which is the ONLY thing that lets the editor use
  the user's real data folder (and migrate old in-worktree data). `pnpm dev:sandbox` is the throwaway-data run; `pnpm dev` also uses the real data folder.
- Idempotent: if something already listens on the port it only opens the browser.
- -Stop stops only the process listening on that port (never all node processes).
- Log: <data folder>\logs\editor-<port>.log
- -DataDir (absolute) points the editor at another data folder (drills and tests use a sandbox folder + spare port).
#>
param(
  [int]$Port = 5211,
  [string]$DataDir = "",
  [switch]$NoBrowser,
  [switch]$Stop
)
$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$editor = Join-Path $repo "packages\animator-editor"
$url = "http://localhost:$Port/"

# Where the data folder is: -DataDir, else the Settings pointer file, else Documents\Atlas Animator (same order as src/dataDirs.ts).
function Get-DataFolder {
  if ($DataDir) { return [System.IO.Path]::GetFullPath($DataDir) }
  try {
    $ptr = Join-Path $env:APPDATA "Atlas Animator\data-location.json"
    if (Test-Path $ptr) {
      $d = (Get-Content -Raw $ptr | ConvertFrom-Json).dataDir
      if ($d -and [System.IO.Path]::IsPathRooted($d)) { return $d }
    }
  } catch { }
  return (Join-Path ([Environment]::GetFolderPath("MyDocuments")) "Atlas Animator")
}
$data = Get-DataFolder
$logDir = Join-Path $data "logs"
$log = Join-Path $logDir "editor-$Port.log"

function Get-PortOwner([int]$p) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return [int]$c.OwningProcess }
  return $null
}

if ($Stop) {
  $user = Get-PortOwner $Port
  if (-not $user) { Write-Host "Nothing is listening on port $Port."; exit 0 }
  Stop-Process -Id $user -Force
  Write-Host "Stopped the process on port $Port (pid $user)."
  exit 0
}

if (Get-PortOwner $Port) {
  Write-Host "Atlas Animator is already running on port $Port."
} else {
  if (-not (Test-Path (Join-Path $editor "package.json"))) { throw "Cannot find the editor at $editor" }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is not installed or not on PATH." }
  $vite = Join-Path $editor "node_modules\vite\bin\vite.js"
  if (-not (Test-Path $vite)) { throw "Vite is missing ($vite). Run 'pnpm install' once in $repo" }
  New-Item -ItemType Directory -Force $logDir | Out-Null
  $node = (Get-Command node).Source
  # WMI-created processes do not inherit this shell's environment, so the variables are set inside the command line.
  $envSet = "set `"ATLAS_EDITOR_USER_DATA=1`""
  if ($DataDir) { $envSet += " && set `"ATLAS_EDITOR_DATA_DIR=$data`"" }
  $inner = "$envSet && `"$node`" `"$vite`" --port $Port --strictPort >> `"$log`" 2>&1"
  $cmdline = "cmd.exe /d /s /c `"$inner`""
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmdline; CurrentDirectory = $editor }
  if ($r.ReturnValue -ne 0) { throw "Could not start the editor (WMI code $($r.ReturnValue))." }
  Write-Host "Starting Atlas Animator on port $Port ..."
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Get-PortOwner $Port)) {
    if (-not (Get-Process -Id $r.ProcessId -ErrorAction SilentlyContinue)) { throw "The editor stopped right after starting. See $log" }
    if ((Get-Date) -gt $deadline) { throw "The editor did not start within 60 s. See $log" }
    Start-Sleep -Milliseconds 500
  }
  Write-Host "Ready: $url   (log: $log)"
}
if (-not $NoBrowser) { Start-Process $url }
