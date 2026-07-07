<#
.SYNOPSIS
  Install a released atomic-agent CLI (Node SEA) from GitHub Releases on Windows.

.DESCRIPTION
  Windows counterpart of scripts/install.sh. Downloads the release zip, verifies
  its SHA256 checksum, extracts the CLI plus support assets (grammars/, vendor/,
  node_modules/, starter-skills/, assets/) into an install directory, and adds
  that directory to the user PATH.

.EXAMPLE
  irm https://raw.githubusercontent.com/AtomicBot-ai/atomic-agent/main/scripts/install.ps1 | iex

.NOTES
  Environment overrides (mirrors install.sh):
    ATOMIC_AGENT_REPO         owner/atomic-agent   (default: AtomicBot-ai/atomic-agent)
    ATOMIC_AGENT_VERSION      v0.1.0               (optional: pin a tag; default: latest)
    ATOMIC_AGENT_INSTALL_DIR  path                 (default: %LOCALAPPDATA%\atomic-agent)
    ATOMIC_AGENT_NO_PATH      1                    (optional: skip user PATH update)
#>

$ErrorActionPreference = "Stop"

# PowerShell 5.1 defaults to TLS 1.0/1.1; GitHub requires TLS 1.2+.
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
  # Older frameworks may not expose Tls12 by name — best effort.
}

$RepoDefault = "AtomicBot-ai/atomic-agent"
$Repo = if ($env:ATOMIC_AGENT_REPO) { $env:ATOMIC_AGENT_REPO } else { $RepoDefault }
$Version = $env:ATOMIC_AGENT_VERSION
$InstallDir = if ($env:ATOMIC_AGENT_INSTALL_DIR) {
  $env:ATOMIC_AGENT_INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA "atomic-agent"
}

function Write-Info($msg) { Write-Host $msg }
function Fail($msg) { Write-Error $msg; exit 1 }

# Suffix for files moved aside during a self-update over a running install.
$script:BackupStamp = Get-Date -Format "yyyyMMddHHmmss"

# Best-effort removal of leftover *.old-* files from a previous self-update.
# A file still mapped by a live process stays locked; skip it and let a
# later run clean it up.
function Remove-StaleBackups($dir) {
  Get-ChildItem -Path $dir -Recurse -File -Filter "*.old-*" -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
    } catch {
      Write-Info "note: could not remove stale $($_.Name) (in use); it will be cleaned on a later update"
    }
  }
}

# Copy a staged tree onto the install dir, tolerating files the running
# process holds open (its own atomic-agent.exe, the loaded
# better_sqlite3.node). Windows forbids overwriting a locked file but
# allows renaming it, so we move the locked target aside to
# <name>.old-<stamp> and write the fresh copy in its place. The live
# process keeps executing from the moved inode until the user relaunches.
# This is what makes in-app self-update work on Windows.
function Copy-TreeWithSwap($src, $dst) {
  foreach ($item in Get-ChildItem -LiteralPath $src -Recurse -File) {
    $rel = $item.FullName.Substring($src.Length).TrimStart('\', '/')
    $target = Join-Path $dst $rel
    $targetDir = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $targetDir)) {
      New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }
    try {
      Copy-Item -LiteralPath $item.FullName -Destination $target -Force -ErrorAction Stop
    } catch {
      $backup = "$target.old-$script:BackupStamp"
      try {
        Move-Item -LiteralPath $target -Destination $backup -Force -ErrorAction Stop
      } catch {
        Fail ("failed to replace $target (locked and could not be moved aside). " +
          "Close atomic-agent and re-run the installer.`n  $($_.Exception.Message)")
      }
      Copy-Item -LiteralPath $item.FullName -Destination $target -Force
    }
  }
}

# Only win32-x64 is published today. On ARM64 Windows the x64 build still runs
# under the OS x64 emulation layer, so we install it and warn.
$archRaw = $env:PROCESSOR_ARCHITECTURE
if ($archRaw -and $archRaw -ne "AMD64") {
  Write-Info "note: detected PROCESSOR_ARCHITECTURE=$archRaw; only a win32-x64 build is published."
  Write-Info "      it will run through the Windows x64 emulation layer."
}
$Slug = "win32-x64"
$ArchiveName = "atomic-agent-$Slug.zip"

$Base = "https://github.com/$Repo"
if ($Version) {
  $ZipUrl = "$Base/releases/download/$Version/$ArchiveName"
  $ShaUrl = "$Base/releases/download/$Version/$ArchiveName.sha256"
} else {
  $ZipUrl = "$Base/releases/latest/download/$ArchiveName"
  $ShaUrl = "$Base/releases/latest/download/$ArchiveName.sha256"
}

Write-Info "downloading $ArchiveName from $Repo ..."

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("atomic-agent-install-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Work -Force | Out-Null

try {
  $ZipPath = Join-Path $Work $ArchiveName
  $ShaPath = "$ZipPath.sha256"

  Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipPath -UseBasicParsing
  Invoke-WebRequest -Uri $ShaUrl -OutFile $ShaPath -UseBasicParsing

  # The .sha256 file is `shasum -a 256`-style: "<hex>  <filename>".
  $expected = ((Get-Content -Path $ShaPath -Raw).Trim() -split '\s+')[0].ToLower()
  if (-not $expected) {
    Fail "could not read expected checksum from $ArchiveName.sha256"
  }
  $actual = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected) {
    Fail "checksum mismatch for $ArchiveName`n  expected: $expected`n  actual:   $actual"
  }
  Write-Info "checksum verified"

  # Extract into a fresh staging dir. The Windows zip stores files at its root
  # (no top-level <slug>/ wrapper), unlike the Unix tarball.
  $Stage = Join-Path $Work "stage"
  New-Item -ItemType Directory -Path $Stage -Force | Out-Null
  Expand-Archive -Path $ZipPath -DestinationPath $Stage -Force

  $BinaryPath = Join-Path $Stage "atomic-agent.exe"
  if (-not (Test-Path $BinaryPath)) {
    Fail "binary atomic-agent.exe not found in archive $ArchiveName"
  }

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

  # Self-update-safe install: drop stale backups from a previous update, then
  # copy the staged tree in, moving locked files (the running .exe / loaded
  # .node) aside instead of failing. This lets an already-running install
  # upgrade itself; relaunch afterwards to run the new binary.
  Remove-StaleBackups $InstallDir
  Copy-TreeWithSwap $Stage $InstallDir

  Write-Info ""
  Write-Info "installed atomic-agent to $InstallDir\atomic-agent.exe"
}
finally {
  Remove-Item -Path $Work -Recurse -Force -ErrorAction SilentlyContinue
}

function Add-ToUserPath($dir) {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $current) { $current = "" }
  $entries = $current -split ';' | Where-Object { $_ -ne "" }
  foreach ($e in $entries) {
    if ($e.TrimEnd('\') -ieq $dir.TrimEnd('\')) {
      Write-Info "PATH already contains $dir"
      return
    }
  }
  if ($env:ATOMIC_AGENT_NO_PATH -eq "1") {
    Write-Info "add to PATH manually (PowerShell):"
    Write-Info "  [Environment]::SetEnvironmentVariable('Path', `"$dir;`$([Environment]::GetEnvironmentVariable('Path','User'))`", 'User')"
    return
  }
  $sep = if ($current.Length -gt 0 -and -not $current.EndsWith(';')) { ";" } else { "" }
  $updated = "$current$sep$dir"
  [Environment]::SetEnvironmentVariable("Path", $updated, "User")
  # Reflect in the current session too so `atomic-agent` works right away.
  $env:Path = "$env:Path;$dir"
  Write-Info "added $dir to user PATH (open a new terminal for it to take effect everywhere)"
}

Add-ToUserPath $InstallDir

Write-Info ""
Write-Info "to run:"
Write-Info "  atomic-agent"
